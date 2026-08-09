import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side } from 'shared/domain.js'
import { acquireSymbol, openTrade } from '../src/state/trades.js'
import {
  applyExecutionPush,
  applyOrderPush,
  applyPositionPush,
  BybitPrivateWs,
  mapOrderStatus,
  parseFrame,
  parseOpAck,
  signWsAuth,
  toExecutionPush,
  toOrderPush,
  toPositionPush,
  toWalletPush,
  type BybitPrivateWsRestClient,
  type PositionPush,
} from '../src/bybit/private-ws.js'

// Приватный WS-мост Bybit (Ф3, задача 3; research bybit-execution.md §11/§12/§14). Две группы:
//  1) ЖИВАЯ (BYBIT_LIVE_TESTS=1, тот же гейт, что bybit-rest.test.ts): реальный хендшейк testnet —
//     op:auth success -> op:subscribe success. Позиций на аккаунте нет (research §11) — данные-пуши
//     не придут, для приёмки достаточно подтверждённого хендшейка.
//  2) МОК/ИНТЕГРАЦИОННЫЕ (реальная тестовая Postgres, БЕЗ сети): apply*Push — чистые DB-эффекты,
//     тот же паттерн, что applyMarkPriceTick в market-data/apply-tick.test.ts. Плюс несколько чистых
//     unit-тестов на парсеры/сигнатуру (без БД и без сети).

const BYBIT_LIVE_TESTS = process.env.BYBIT_LIVE_TESTS === '1'
if (!BYBIT_LIVE_TESTS) {
  console.warn('[bybit-private-ws.test] живой Bybit-хендшейк пропущен; задайте BYBIT_LIVE_TESTS=1 для запуска (testnet)')
}
const describeLive = BYBIT_LIVE_TESTS ? describe : describe.skip

describeLive('BybitPrivateWs (живой testnet) — требует BYBIT_LIVE_TESTS=1', () => {
  it('op:auth success -> op:subscribe success (позиций нет — data-пушей не будет)', async () => {
    const apiKey = process.env.BYBIT_API_KEY
    const apiSecret = process.env.BYBIT_API_SECRET
    const network = process.env.BYBIT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_LIVE_TESTS=1, но BYBIT_API_KEY/BYBIT_API_SECRET не заданы в .env')
    }

    const db = createDb(process.env.DATABASE_URL!)
    const logs: string[] = []
    const log = {
      log: (...args: unknown[]) => {
        const line = args.map(String).join(' ')
        logs.push(line)
        console.log('[live]', ...args)
      },
      warn: (...args: unknown[]) => console.warn('[live]', ...args),
      error: (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
        console.error('[live]', ...args)
      },
    }

    const rest: BybitPrivateWsRestClient = { cancelAll: async () => ({ ok: true as const }) }
    const ws = new BybitPrivateWs({ apiKey, apiSecret, network, db, rest, log })
    try {
      ws.start()
      // Реальный хендшейк — сеть, ждём фактическое подтверждение auth+subscribe (не мок таймеров).
      await new Promise((resolve) => setTimeout(resolve, 5000))
      expect(logs.some((l) => l.includes('auth success'))).toBe(true)
      expect(logs.some((l) => l.includes('subscribe success'))).toBe(true)
    } finally {
      ws.stop()
      await db.destroy()
    }
  }, 15_000)
})

describe('signWsAuth (HMAC WS-аутентификации, §11)', () => {
  it('детерминирована: тот же вход -> та же подпись', () => {
    const a = signWsAuth('secret123', 1_700_000_000_000)
    const b = signWsAuth('secret123', 1_700_000_000_000)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('разные expires -> разные подписи', () => {
    expect(signWsAuth('secret123', 1)).not.toBe(signWsAuth('secret123', 2))
  })
})

describe('parseOpAck / parseFrame — чистые парсеры (без сети)', () => {
  it('op:auth success', () => {
    expect(parseOpAck('{"op":"auth","success":true}')).toEqual({ op: 'auth', success: true, retMsg: null })
  })

  it('op:subscribe failure с ret_msg', () => {
    expect(parseOpAck('{"op":"subscribe","success":false,"ret_msg":"boom"}')).toEqual({
      op: 'subscribe',
      success: false,
      retMsg: 'boom',
    })
  })

  it('битый JSON / без op -> null', () => {
    expect(parseOpAck('not json')).toBeNull()
    expect(parseOpAck('{"topic":"position","data":[]}')).toBeNull()
  })

  it('parseFrame: topic + data', () => {
    expect(parseFrame('{"topic":"position","data":[{"symbol":"BTCUSDT"}]}')).toEqual({
      topic: 'position',
      data: [{ symbol: 'BTCUSDT' }],
    })
  })

  it('parseFrame: без topic -> null', () => {
    expect(parseFrame('{"op":"ping"}')).toBeNull()
  })
})

describe('mapOrderStatus', () => {
  it('маппит известные статусы Bybit -> наш order_status', () => {
    expect(mapOrderStatus('New')).toBe('submitted')
    expect(mapOrderStatus('PartiallyFilled')).toBe('partially_filled')
    expect(mapOrderStatus('Filled')).toBe('filled')
    expect(mapOrderStatus('Cancelled')).toBe('cancelled')
    expect(mapOrderStatus('Rejected')).toBe('rejected')
  })

  it('неизвестный статус -> submitted (защитный дефолт)', () => {
    expect(mapOrderStatus('SomethingNew')).toBe('submitted')
  })
})

describe('toPositionPush / toExecutionPush / toOrderPush / toWalletPush', () => {
  it('toPositionPush: обязательные поля есть -> объект; markPrice="" трактуется как отсутствие', () => {
    const push = toPositionPush({ symbol: 'BTCUSDT', side: 'Buy', size: '0.5', markPrice: '' })
    expect(push).toMatchObject({ symbol: 'BTCUSDT', side: 'Buy', size: '0.5', markPrice: null })
  })

  it('toPositionPush: нет symbol -> null', () => {
    expect(toPositionPush({ side: 'Buy', size: '0.5' })).toBeNull()
  })

  it('toPositionPush: side="" (плоская позиция — реальный формат Bybit на закрытии) -> объект, НЕ null', () => {
    // Фикс p3-task6-demo (найдено живьём: ручное закрытие позиции на demo НИКОГДА не долетало
    // до closeTrade/releaseSymbol/cancelAll через приватный WS). Bybit шлёт финальный пуш
    // `position size→0` с side="" (пустая строка, не 'None') — старый asNonEmptyString(o.side)
    // трактовал '' как "поле отсутствует" и ронял ВЕСЬ объект в null, событие закрытия молча
    // терялось целиком (в отличие от markPrice="" выше — там '' ЗАКОННО означает "поле не пришло").
    const push = toPositionPush({ symbol: 'SOLUSDT', side: '', size: '0' })
    expect(push).toMatchObject({ symbol: 'SOLUSDT', side: '', size: '0' })
  })

  it('toExecutionPush: обязательные поля есть -> объект', () => {
    const push = toExecutionPush({
      symbol: 'BTCUSDT',
      side: 'Sell',
      execId: 'e1',
      orderId: 'o1',
      orderLinkId: 'TR1-TP1',
      execQty: '0.1',
      execPrice: '100',
      closedSize: '0.1',
    })
    expect(push).toMatchObject({ execId: 'e1', orderId: 'o1', orderLinkId: 'TR1-TP1', closedSize: '0.1' })
  })

  it('toOrderPush: обязательные поля есть -> объект', () => {
    expect(toOrderPush({ orderId: 'o1', orderLinkId: 'TR1-E0', orderStatus: 'Filled' })).toEqual({
      symbol: null,
      orderId: 'o1',
      orderLinkId: 'TR1-E0',
      orderStatus: 'Filled',
    })
  })

  it('toWalletPush: totalEquity', () => {
    expect(toWalletPush({ accountType: 'UNIFIED', totalEquity: '999.5' })).toEqual({
      accountType: 'UNIFIED',
      totalEquity: '999.5',
    })
  })
})

// ---------------------------------------------------------------------------
// Интеграционные тесты apply*Push против реальной тестовой Postgres (без сети).
// ---------------------------------------------------------------------------

let db: Kysely<DB>

const CHANNEL_ID = 1
const CHANNEL_ORD = 1
// Второй канал — «канал чужого аккаунта» для блока про скоуп атрибуции (субаккаунты).
const OTHER_CHANNEL_ID = 2
const OTHER_CHANNEL_ORD = 2

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES
      (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1'),
      (${OTHER_CHANNEL_ID}, ${OTHER_CHANNEL_ORD}, 'ch2', 'channel', 'ch2')
  `.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

let tgMessageSeq = 800_000

async function seedMessage(channelId: number = CHANNEL_ID): Promise<{ messageId: string; tgMessageId: number }> {
  const tgMessageId = tgMessageSeq++
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: channelId,
      tg_message_id: tgMessageId,
      is_topic_message: false,
      text: '',
      has_media: false,
      msg_ts: new Date(),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { messageId: row.id, tgMessageId }
}

async function seedAction(params: { messageId: string; symbol: string; side: Side; channelId?: number }): Promise<string> {
  const row = await db
    .insertInto('actions')
    .values({
      message_id: params.messageId,
      channel_id: params.channelId ?? CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side: params.side,
      symbol: params.symbol,
      method: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** Сделка + активное владение символом (attributeSymbol в private-ws.ts читает symbol_ownership). */
async function setupTrade(symbol: string, side: Side, channelId: number = CHANNEL_ID): Promise<{ tradeId: string; actionId: string }> {
  const { messageId } = await seedMessage(channelId)
  const actionId = await seedAction({ messageId, symbol, side, channelId })
  const trade = await openTrade(db, { channelId, symbol, side, openedActionId: actionId, openedMsgId: messageId })
  const acquired = await acquireSymbol(db, { channelId, symbol, tradeId: trade.tradeId })
  expect(acquired).toBe(true)
  return { tradeId: trade.tradeId, actionId }
}

async function seedOrder(params: { tradeId: string; actionId: string; symbol: string; side: Side; orderLinkId: string }): Promise<void> {
  await db
    .insertInto('orders')
    .values({
      trade_id: params.tradeId,
      action_id: params.actionId,
      channel_id: CHANNEL_ID,
      symbol: params.symbol,
      order_link_id: params.orderLinkId,
      purpose: 'entry',
      side: params.side,
      order_type: 'market',
      status: 'submitted',
      submitted_at: new Date(),
    })
    .execute()
}

function buildPositionPush(overrides: Partial<PositionPush> & Pick<PositionPush, 'symbol' | 'side' | 'size'>): PositionPush {
  return {
    entryPrice: null,
    markPrice: null,
    liqPrice: null,
    leverage: null,
    takeProfit: null,
    stopLoss: null,
    unrealisedPnl: null,
    curRealisedPnl: null,
    positionStatus: null,
    seq: null,
    ...overrides,
  }
}

function mockCancelAllRest(): { rest: BybitPrivateWsRestClient; calls: string[] } {
  const calls: string[] = []
  return {
    rest: {
      cancelAll: vi.fn(async (symbol: string) => {
        calls.push(symbol)
        return { ok: true as const }
      }),
    },
    calls,
  }
}

describe('applyPositionPush', () => {
  it('size=0 -> position.close опубликован, releaseSymbol и cancelAll(symbol) вызваны (R8)', async () => {
    const symbol = 'BTCUSDT'
    const { tradeId } = await setupTrade(symbol, 'long')
    const { rest, calls } = mockCancelAllRest()

    // Позиция сперва РЕАЛЬНО открывается. Без этого шага flat-пуш больше не считается закрытием:
    // Bybit шлёт size=0 и в момент открытия (слот заведён, филла ещё нет), и раньше такой пуш
    // закрывал только что открытую сделку, снимая с неё защитный стоп (см. регрессию ниже).
    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '0.5', seq: 1 }), rest)
    calls.length = 0

    const notified = await applyPositionPush(
      db,
      buildPositionPush({ symbol, side: 'Sell', size: '0', curRealisedPnl: '12.5', seq: 2 }),
      rest,
    )

    expect(notified).toBe(true)
    expect(calls).toEqual([symbol]) // cancelAll вызван РОВНО с этим символом

    const trade = await db.selectFrom('trades').select(['status', 'closed_at']).where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('closed')
    expect(trade.closed_at).not.toBeNull()

    const ownership = await db
      .selectFrom('symbol_ownership')
      .select('released_at')
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(ownership.released_at).not.toBeNull() // releaseSymbol реально освободил владение

    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'position.close')
      .where('aggregate_id', '=', `${CHANNEL_ID}:${symbol}`)
      .executeTakeFirstOrThrow()
    const payload = event.payload as { channelId: number; symbol: string; tradeRef: string | null; realizedPnl: string }
    expect(payload.channelId).toBe(CHANNEL_ID)
    expect(payload.symbol).toBe(symbol)
    expect(payload.tradeRef).toMatch(/^TR-\d+$/)

    // Символ освобождён -> позиция тоже отражает size=0 (position.upsert публикуется всегда).
    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('0.0000000000')

    const upsertEvent = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'position.upsert')
      .where('aggregate_id', '=', `${CHANNEL_ID}:${symbol}`)
      .executeTakeFirstOrThrow()
    expect(upsertEvent).toBeDefined()
  })

  it('snapshot затем delta без markPrice -> markPrice сохраняется от snapshot (мерж дельт)', async () => {
    const symbol = 'ETHUSDT'
    await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    await applyPositionPush(
      db,
      buildPositionPush({ symbol, side: 'Buy', size: '1.5', entryPrice: '3000', markPrice: '3050', seq: 1 }),
      rest,
    )
    const afterSnapshot = await db
      .selectFrom('positions')
      .select('mark_price')
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(afterSnapshot.mark_price).toBe('3050.0000000000')

    // Дельта: markPrice отсутствует (null), но size/entryPrice те же — тот же приём, что
    // public tickers (research §12), только для приватного position-стрима.
    await applyPositionPush(
      db,
      buildPositionPush({ symbol, side: 'Buy', size: '1.5', entryPrice: '3000', markPrice: null, seq: 2 }),
      rest,
    )
    const afterDelta = await db
      .selectFrom('positions')
      .select('mark_price')
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(afterDelta.mark_price).toBe('3050.0000000000') // не затёрто null'ом
  })

  it('устаревший seq (не новее сохранённого) -> пуш игнорируется (водяной знак §14)', async () => {
    const symbol = 'SOLUSDT'
    await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '10', markPrice: '150', seq: 5 }), rest)
    // seq=3 < 5 — переупорядоченный при реконнекте пуш, не должен откатить markPrice/size назад.
    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '999', markPrice: '1', seq: 3 }), rest)

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.mark_price).toBe('150.0000000000')
    expect(row.size).toBe('10.0000000000')
  })

  it('хвостовой flat-пуш после НАШЕГО закрытия атрибутируется по недавно закрытой сделке (без warn)', async () => {
    // Пайплайн зануляет зеркало сам, сразу после своего полного закрытия — значит фолбэк
    // «последняя строка positions с size<>0» до финального пуша не доживает. Без отдельного
    // фолбэка на недавно закрытую сделку КАЖДОЕ штатное закрытие писало бы в лог предупреждение
    // «владение символом не найдено», и оно перестало бы что-либо значить.
    const symbol = 'NEARUSDT'
    const { tradeId } = await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '5', seq: 20 }), rest)
    // Имитируем работу пайплайна: сделка закрыта, владение снято, зеркало обнулено.
    await db.updateTable('trades').set({ status: 'closed', closed_at: new Date() }).where('id', '=', tradeId).execute()
    await db.updateTable('symbol_ownership').set({ released_at: new Date() }).where('trade_id', '=', tradeId).execute()
    await db.updateTable('positions').set({ size: '0' }).where('channel_id', '=', CHANNEL_ID).where('symbol', '=', symbol).execute()

    const applied = await applyPositionPush(db, buildPositionPush({ symbol, side: '', size: '0', seq: 21 }), rest)

    expect(applied).toBe(true) // пуш атрибутирован и применён, а не выброшен с предупреждением
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('0.0000000000')
    expect(Number(row.bybit_seq)).toBe(21)
  })

  it('КОНКУРЕНТНЫЕ фреймы: устаревший пуш не воскрешает закрытую позицию (водяной знак в самом UPDATE)', async () => {
    // Живой e2e (3 прогона из 5): позиция закрыта, на бирже пусто — а строка positions осталась с
    // размером ДО закрытия. Фреймы WS обрабатываются КОНКУРЕНТНО (handleMessage вызывается без
    // await), и проверка seq отдельным SELECT'ом их не спасает: обе транзакции успевают прочитать
    // один и тот же старый seq, и та, что коммитится второй, затирает более свежее состояние.
    // Теперь условие стоит в самом UPDATE — исход детерминирован независимо от порядка коммитов.
    const symbol = 'AVAXUSDT'
    await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '7', markPrice: '30', seq: 10 }), rest)

    // Закрытие (seq=12) и переупорядоченный «живой» пуш (seq=11) — одновременно, в обоих порядках.
    await Promise.all([
      applyPositionPush(db, buildPositionPush({ symbol, side: '', size: '0', seq: 12 }), rest),
      applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '7', markPrice: '30', seq: 11 }), rest),
    ])

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('0.0000000000')
    expect(Number(row.bybit_seq)).toBe(12)
  })

  it('пуш с ТЕМ ЖЕ seq, что уже сохранён (перенос SL/TP не бампает seq биржи) -> всё равно применяется', async () => {
    // Фикс p3-task6-demo (найдено живьём на demo, приёмка UI задачи 6): Bybit не увеличивает
    // seq позиции на переносе SL/TP (`position/trading-stop`) — только на реальных исполнениях.
    // Со старым водяным знаком (`<=`) повторный пуш с ТЕМ ЖЕ seq после переноса SL молча
    // отбрасывался бы как "не новее", и stopLoss в UI навсегда замирал на значении входа.
    // LTCUSDT — свой символ (не переиспользует SOLUSDT/BTCUSDT/... соседних тестов этого файла):
    // resetTestSchema вызывается один раз на весь describe, а не на каждый тест, поэтому
    // acquireSymbol на уже занятом соседним тестом символе тихо провалился бы (false).
    const symbol = 'LTCUSDT'
    await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '10', markPrice: '150', stopLoss: '140', seq: 5 }), rest)
    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '10', markPrice: '150', stopLoss: '145', seq: 5 }), rest)

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.stop_loss).toBe('145.0000000000')
  })

  // Регрессия «позиция не видна в UI» (13.07.2026): market-ордер уходит на биржу ИЗНУТРИ ещё не
  // закоммиченной транзакции pipeline, биржа исполняет его за миллисекунды и шлёт пуш — а этот
  // обработчик читает БД на другом соединении и незакоммиченного symbol_ownership не видит. Раньше
  // такой пуш дропался НАВСЕГДА: позиция не попадала в `positions` и становилась не только невидимой
  // в админке, но и НЕУПРАВЛЯЕМОЙ (pipeline резолвит сделку для дельт через positions.size <> 0).
  it('пуш пришёл ДО коммита владения символом -> ретрай дожидается и применяет пуш', async () => {
    const symbol = 'RACEUSDT'
    const { rest } = mockCancelAllRest()

    // Пуш стартует, когда владения ещё нет — как при живой гонке.
    const pushPromise = applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '0.1' }), rest)

    // ...а «транзакция pipeline» коммитит владение спустя полсекунды.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await setupTrade(symbol, 'long')

    expect(await pushPromise).toBe(true)

    const row = await db.selectFrom('positions').selectAll().where('symbol', '=', symbol).executeTakeFirstOrThrow()
    expect(Number(row.size)).toBe(0.1)
  }, 20_000)

  // Пуш РЕАЛЬНО чужого символа (ручная торговля с того же аккаунта) обязан быть отброшен, а не
  // создать фантомную строку в positions. Ретрай атрибуции (гонка «пуш раньше коммита») этот
  // инвариант не отменяет — лишь откладывает дроп до исчерпания попыток (~6.2с), отсюда timeout.
  it('символ без владения в БД -> после исчерпания ретраев атрибуции предупреждение, без записи в positions, cancelAll не вызван', async () => {
    const { rest, calls } = mockCancelAllRest()
    const notified = await applyPositionPush(db, buildPositionPush({ symbol: 'UNKNOWNUSDT', side: 'Buy', size: '1' }), rest)
    expect(notified).toBe(false)
    expect(calls).toEqual([])
    const row = await db.selectFrom('positions').selectAll().where('symbol', '=', 'UNKNOWNUSDT').executeTakeFirst()
    expect(row).toBeUndefined()
  }, 20_000)
})

describe('applyExecutionPush', () => {
  it('closedSize>0 -> вставка executions, атрибуция по orderLinkId, пересчёт trades.realized_pnl; повтор bybit_exec_id не дублирует', async () => {
    const symbol = 'XRPUSDT'
    const { tradeId, actionId } = await setupTrade(symbol, 'long')
    const orderLinkId = 'TR-XRP-TP1'
    await seedOrder({ tradeId, actionId, symbol, side: 'long', orderLinkId })

    const push = {
      symbol,
      side: 'Sell',
      execId: 'exec-abc-1',
      orderId: 'bybit-order-1',
      orderLinkId,
      execQty: '50',
      execPrice: '2.5',
      closedSize: '50',
      leavesQty: '0',
      execFee: '0.05',
      execPnl: '12.5',
      execType: 'Trade',
      isMaker: false,
      execTime: String(Date.now()),
    }

    const first = await applyExecutionPush(db, push)
    expect(first).toBe(true)

    const countAfterFirst = await db
      .selectFrom('executions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('bybit_exec_id', '=', push.execId)
      .executeTakeFirstOrThrow()
    expect(Number(countAfterFirst.n)).toBe(1)

    const execRow = await db.selectFrom('executions').selectAll().where('bybit_exec_id', '=', push.execId).executeTakeFirstOrThrow()
    expect(execRow.trade_id).toBe(tradeId) // атрибуция к сделке по orderLinkId
    expect(execRow.closed_size).toBe('50.0000000000')

    const tradeAfterFirst = await db.selectFrom('trades').select('realized_pnl').where('id', '=', tradeId).executeTakeFirstOrThrow()
    // НЕТТО: брутто-филл 12.5 минус комиссия 0.05 — ровно то, на что изменился баланс.
    expect(tradeAfterFirst.realized_pnl).toBe('12.4500000000')

    // Повтор того же bybit_exec_id (реконнект/редоставка) — идемпотентно, не дублирует и не задваивает PnL.
    const second = await applyExecutionPush(db, push)
    expect(second).toBe(false)

    const countAfterSecond = await db
      .selectFrom('executions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('bybit_exec_id', '=', push.execId)
      .executeTakeFirstOrThrow()
    expect(Number(countAfterSecond.n)).toBe(1)

    const tradeAfterSecond = await db.selectFrom('trades').select('realized_pnl').where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(tradeAfterSecond.realized_pnl).toBe('12.4500000000')
  })
})

describe('applyOrderPush', () => {
  it('обновляет orders.status/bybit_order_id по orderLinkId и публикует order.resolved', async () => {
    const symbol = 'ADAUSDT'
    const { tradeId, actionId } = await setupTrade(symbol, 'short')
    const orderLinkId = 'TR-ADA-E0'
    await seedOrder({ tradeId, actionId, symbol, side: 'short', orderLinkId })

    const notified = await applyOrderPush(db, { symbol, orderId: 'bybit-order-42', orderLinkId, orderStatus: 'Filled' })
    expect(notified).toBe(true)

    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', orderLinkId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
    expect(order.bybit_order_id).toBe('bybit-order-42')
    expect(order.filled_at).not.toBeNull()

    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'order.resolved')
      .where('aggregate_id', '=', order.id)
      .executeTakeFirstOrThrow()
    const payload = event.payload as {
      channelId: number
      tradeId: string | null
      symbol: string
      orderLinkId: string
      bybitOrderId: string | null
      status: string
    }
    expect(payload).toEqual({
      channelId: CHANNEL_ID,
      tradeId,
      symbol,
      orderLinkId,
      bybitOrderId: 'bybit-order-42',
      status: 'filled',
    })
  })

  // Как и в applyPositionPush: ордер действительно чужой -> дроп, но уже после ретраев (~6.2с).
  it('неизвестный orderLinkId -> после исчерпания ретраев no-op, не бросает, событие не публикуется', async () => {
    const notified = await applyOrderPush(db, { symbol: 'BTCUSDT', orderId: 'x', orderLinkId: 'NOSUCH-E0', orderStatus: 'Filled' })
    expect(notified).toBe(false)
    const event = await db.selectFrom('domain_events').selectAll().where('aggregate_id', '=', 'NOSUCH-E0').executeTakeFirst()
    expect(event).toBeUndefined()
  }, 20_000)

  // Ретрай выше означает, что пуши по одному ордеру могут примениться не в порядке прихода (у
  // order.linear нет seq-водяного знака, в отличие от position). Задержавшийся 'New' не должен
  // откатывать уже записанный 'Filled' — иначе cancel_pending попытается отменить исполненный ордер.
  it('терминальный статус не понижается: задержавшийся New после Filled не откатывает orders.status', async () => {
    const symbol = 'TERMUSDT'
    const { tradeId, actionId } = await setupTrade(symbol, 'long')
    const orderLinkId = 'TR-TERM-E0'
    await seedOrder({ tradeId, actionId, symbol, side: 'long', orderLinkId })

    await applyOrderPush(db, { symbol, orderId: 'oid-1', orderLinkId, orderStatus: 'Filled' })
    await applyOrderPush(db, { symbol, orderId: 'oid-1', orderLinkId, orderStatus: 'New' })

    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', orderLinkId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
  })
})

describe('BybitPrivateWs — диспетчеризация сырых фреймов по topic (без сети, без start()/connect())', () => {
  it('bare topic "position"/"order" (НЕ ".linear" — так реально приходит с биржи, §11) маршрутизируются в apply*Push', async () => {
    const symbol = 'DOTUSDT'
    const { tradeId, actionId } = await setupTrade(symbol, 'long')
    const orderLinkId = 'TR-DOT-E0'
    await seedOrder({ tradeId, actionId, symbol, side: 'long', orderLinkId })
    const { rest } = mockCancelAllRest()

    // Приватный конструктор не подключается к сети сам по себе (connect() зовётся только из
    // start()) — handleMessage можно дёргать напрямую, минуя реальный WebSocket.
    const ws = new BybitPrivateWs({ apiKey: 'k', apiSecret: 's', network: 'testnet', db, rest })
    const dispatch = ws as unknown as { handleMessage(raw: string): Promise<void> }

    await dispatch.handleMessage(
      JSON.stringify({ topic: 'position', data: [{ symbol, side: 'Buy', size: '2', entryPrice: '100', markPrice: '105', seq: 1 }] }),
    )
    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(position.mark_price).toBe('105.0000000000')

    await dispatch.handleMessage(JSON.stringify({ topic: 'order', data: [{ orderId: 'bx-1', orderLinkId, orderStatus: 'Filled' }] }))
    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', orderLinkId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
    expect(order.bybit_order_id).toBe('bx-1')

    // op:auth/op:subscribe ack — не топик-фрейм, не должен маршрутизироваться как данные.
    await expect(dispatch.handleMessage('{"op":"auth","success":true}')).resolves.toBeUndefined()
  })

  it('Important I3 адверсариального ревью: ".linear"-суффиксные топики (РЕАЛЬНЫЙ формат подписки — SUBSCRIBE_TOPICS шлёт именно их) маршрутизируются так же, как bare-имена', async () => {
    const symbol = 'FTMUSDT'
    const { tradeId, actionId } = await setupTrade(symbol, 'long')
    const orderLinkId = 'TR-FTM-E0'
    await seedOrder({ tradeId, actionId, symbol, side: 'long', orderLinkId })
    const { rest } = mockCancelAllRest()

    const ws = new BybitPrivateWs({ apiKey: 'k', apiSecret: 's', network: 'testnet', db, rest })
    const dispatch = ws as unknown as { handleMessage(raw: string): Promise<void> }

    await dispatch.handleMessage(
      JSON.stringify({ topic: 'position.linear', data: [{ symbol, side: 'Buy', size: '3', entryPrice: '1', markPrice: '1.1', seq: 1 }] }),
    )
    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(position.mark_price).toBe('1.1000000000')

    await dispatch.handleMessage(JSON.stringify({ topic: 'order.linear', data: [{ orderId: 'bx-linear-1', orderLinkId, orderStatus: 'Filled' }] }))
    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', orderLinkId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
    expect(order.bybit_order_id).toBe('bx-linear-1')

    // execution.linear/wallet — те же apply*Push уже покрыты выше на bare-имени; здесь
    // достаточно подтвердить, что ".linear" не ломает диспетчеризацию ни для одного из четырёх.
    await expect(dispatch.handleMessage(JSON.stringify({ topic: 'wallet', data: [{ accountType: 'UNIFIED', totalEquity: '500' }] }))).resolves.toBeUndefined()
  })

  it('фикс p3-task6-demo: РЕАЛЬНЫЙ сырой фрейм закрытия (side="", size="0") реально закрывает #TR-x', async () => {
    // Найдено живьём при ручном закрытии позиции на demo (задача 5, отказоустойчивость):
    // Bybit шлёт финальный `position.linear` пуш с side="" (НЕ 'None' и НЕ отсутствием поля) —
    // до фикса toPositionPush() ронял весь пуш в null на этом самом месте, closeTrade/
    // releaseSymbol/cancelAll (R8) не срабатывали НИКОГДА через реальный WS-путь целиком.
    const symbol = 'MATICUSDT'
    const { tradeId } = await setupTrade(symbol, 'long')
    const { rest, calls } = mockCancelAllRest()

    const ws = new BybitPrivateWs({ apiKey: 'k', apiSecret: 's', network: 'testnet', db, rest })
    const dispatch = ws as unknown as { handleMessage(raw: string): Promise<void> }

    // Позиция сперва реально открылась (иначе size=0 — это пуш-стаб момента открытия, а не закрытие).
    await dispatch.handleMessage(
      JSON.stringify({ topic: 'position.linear', data: [{ symbol, side: 'Buy', size: '1', seq: 98 }] }),
    )

    await dispatch.handleMessage(
      JSON.stringify({ topic: 'position.linear', data: [{ symbol, side: '', size: '0', seq: 99 }] }),
    )

    expect(calls).toEqual([symbol]) // cancelAll реально вызван по живому сырому фрейму закрытия
    const trade = await db.selectFrom('trades').select(['status']).where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('closed')
  })

  it('Important I3: неизвестный topic логируется (warn), а не тихо дропается', async () => {
    const logs: string[] = []
    const log = {
      log: () => {},
      warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: () => {},
    }
    const { rest } = mockCancelAllRest()
    const ws = new BybitPrivateWs({ apiKey: 'k', apiSecret: 's', network: 'testnet', db, rest, log })
    const dispatch = ws as unknown as { handleMessage(raw: string): Promise<void> }

    await dispatch.handleMessage(JSON.stringify({ topic: 'liquidation.linear', data: [{ symbol: 'BTCUSDT' }] }))

    expect(logs.some((l) => l.includes('liquidation.linear'))).toBe(true)
  })
})

// Регрессия (живой инцидент): Bybit при открытии присылает промежуточный пуш позиции с size=0
// (слот заведён, филла ещё нет). Раньше он безвредно отбрасывался — владения символом ещё не было.
// Но с ретраем атрибуции такой пуш ДОЖИДАЕТСЯ коммита и применяется — и код трактовал его как
// «позиция закрылась»: закрывал сделку, снимал владение и делал cancelAll, СНИМАЯ ЗАЩИТНЫЙ СТОП
// с только что открытой позиции. BTC остался висеть на плече 20x без стопа.
describe('applyPositionPush — плоский пуш не закрывает только что открытую сделку', () => {
  it('пуш size=0, когда открытой позиции в зеркале ещё НЕ БЫЛО -> сделка НЕ закрыта, cancelAll не вызван', async () => {
    const symbol = 'FLATUSDT'
    const { tradeId } = await setupTrade(symbol, 'long')
    const { rest, calls } = mockCancelAllRest()

    // Позиции в зеркале ещё нет (строка positions не создана) — как в момент открытия.
    await applyPositionPush(db, buildPositionPush({ symbol, side: '', size: '0' }), rest)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.status).not.toBe('closed') // сделка жива (после openTrade она 'pending')
    expect(trade.closed_at).toBeNull()
    expect(calls).toEqual([]) // защитные ордера НЕ сняты — стоп остался на бирже

    const ownership = await db
      .selectFrom('symbol_ownership')
      .selectAll()
      .where('trade_id', '=', tradeId)
      .executeTakeFirstOrThrow()
    expect(ownership.released_at).toBeNull() // символ не освобождён
  })

  it('пуш size=0 ПОСЛЕ реально открытой позиции -> сделка закрывается (обычное закрытие работает)', async () => {
    const symbol = 'CLOSEUSDT'
    const { tradeId } = await setupTrade(symbol, 'long')
    const { rest } = mockCancelAllRest()

    // Сначала позиция реально открылась...
    await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '1', seq: 1 }), rest)
    // ...а потом закрылась.
    await applyPositionPush(db, buildPositionPush({ symbol, side: '', size: '0', seq: 2 }), rest)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('closed')
  })
})

// Субаккаунты (docs/superpowers/specs/2026-07-26-per-channel-subaccounts-design.md): приватный WS
// поднимается НА АККАУНТ, и его пуши относятся только к каналам этого аккаунта. Без скоупа
// attributeSymbol нашла бы владельца символа в ЛЮБОМ канале — пуш аккаунта A применился бы к
// сделке канала B (чужие деньги, чужое зеркало). channelIds приходит из реестра аккаунтов.
describe('applyPositionPush — скоуп атрибуции по каналам аккаунта (субаккаунты)', () => {
  it('символом владеет ЧУЖОЙ канал -> пуш не применяется, зеркало чужого канала не тронуто', async () => {
    const symbol = 'SCOPEWSAUSDT'
    await setupTrade(symbol, 'long', OTHER_CHANNEL_ID)
    const { rest, calls } = mockCancelAllRest()

    const applied = await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '3', seq: 1 }), rest, [CHANNEL_ID])

    expect(applied).toBe(false)
    expect(calls).toEqual([])
    const row = await db.selectFrom('positions').selectAll().where('symbol', '=', symbol).executeTakeFirst()
    expect(row).toBeUndefined()
    // Отказ атрибуции проходит ПОЛНУЮ лестницу ретраев (ATTRIBUTION_RETRY_DELAYS_MS ≈ 6.2с) —
    // она рассчитана на гонку с коммитом пайплайна, поэтому тесту нужен запас по времени.
  }, 15_000)

  it('символом владеет СВОЙ канал -> пуш применяется как обычно', async () => {
    const symbol = 'SCOPEWSBUSDT'
    const { tradeId } = await setupTrade(symbol, 'long', OTHER_CHANNEL_ID)
    const { rest } = mockCancelAllRest()

    const applied = await applyPositionPush(
      db,
      buildPositionPush({ symbol, side: 'Buy', size: '3', seq: 1 }),
      rest,
      [OTHER_CHANNEL_ID],
    )

    expect(applied).toBe(true)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', OTHER_CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.trade_id).toBe(tradeId)
  })

  it('скоуп НЕ задан (общий аккаунт из env) -> атрибуция ищет владельца во всех каналах, как раньше', async () => {
    const symbol = 'SCOPEWSCUSDT'
    const { tradeId } = await setupTrade(symbol, 'long', OTHER_CHANNEL_ID)
    const { rest } = mockCancelAllRest()

    const applied = await applyPositionPush(db, buildPositionPush({ symbol, side: 'Buy', size: '2', seq: 1 }), rest)

    expect(applied).toBe(true)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', OTHER_CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.trade_id).toBe(tradeId)
  })
})
