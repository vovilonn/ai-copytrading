import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Kysely, sql } from 'kysely'
import { Decimal } from 'decimal.js'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side, TradeStatus } from 'shared/domain.js'
import { acquireSymbol, addLeg, openTrade } from '../src/state/trades.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { BybitAdapter, type BybitAdapterRestClient } from '../src/execution/bybit.adapter.js'
import { BybitRestClient, type ClosedPnl, type Execution, type Order, type Position } from '../src/bybit/rest-client.js'
import { reconcileOnStart, type ReconcileRestClient } from '../src/bybit/reconcile.js'

// reconcileOnStart (Ф3, задача 4; research bybit-execution.md §14): позиция на бирже без TR в
// журнале -> flagged/opened (атрибуция по orderLinkId); TR открыт без позиции на бирже -> closed
// по бирже; совпадение -> синхронизация полей без изменения статуса; createdTime защищает от
// "чужой" позиции. Ключевая проверка ЭТОГО файла: LIVE-реконсиляция различает live/dry-run
// сделки ИСКЛЮЧИТЕЛЬНО по префиксу orders.order_link_id ('K' vs 'D', order-link-id.ts) — dry-run
// сделки НИКОГДА не закрываются реконсиляцией, сколько бы их ни было в журнале (см. reconcile.ts
// топ-комментарий: в dev-БД сейчас ~76 таких сделок Ф1, эта защита — предмет отдельной проверки
// ниже).

let db: Kysely<DB>
const CHANNEL_ID = 1
const CHANNEL_ORD = 1

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

// Второй канал нужен блоку «скоуп по каналам» (субаккаунты): его сделки — это «сделки чужого
// аккаунта», которые сверка не должна трогать. Остальным тестам лишняя строка каналов безразлична —
// реконсиляция ходит по trades/positions, а не по channels.
const OTHER_CHANNEL_ID = 2
const OTHER_CHANNEL_ORD = 2

// reconcileOnStart сканирует ВСЮ таблицу trades (не по одному каналу/символу, в отличие от
// большинства тестов engine) — полный TRUNCATE перед КАЖДЫМ тестом обязателен, иначе сделки
// одного сценария всплывали бы в шаге "закрыть по бирже" следующего сценария.
beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES
      (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1'),
      (${OTHER_CHANNEL_ID}, ${OTHER_CHANNEL_ORD}, 'ch2', 'channel', 'ch2')
  `.execute(db)
})

let tgMessageSeq = 400_000

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

/** BybitAdapter.placeEntry требует запись instruments (округление qty/price) — DryRunAdapter нет. */
async function seedInstrument(symbol: string): Promise<void> {
  await db
    .insertInto('instruments')
    .values({
      symbol,
      network: 'testnet',
      base_coin: symbol.replace(/USDT$/, ''),
      status: 'Trading',
      qty_step: '0.01',
      min_qty: '0.01',
      tick_size: '0.01',
      min_notional: '5',
      max_leverage: '50',
      leverage_step: '1',
      mmr: '0.005',
      refreshed_at: new Date(),
    })
    .onConflict((oc) => oc.columns(['symbol', 'network']).doNothing())
    .execute()
}

/** Мок BybitAdapterRestClient — никакой сети, только чтобы BybitAdapter.placeEntry смог
 *  сгенерировать настоящий 'K'-orderLinkId и записать реальную строку orders. */
function createMockBybitRest(): BybitAdapterRestClient {
  let orderSeq = 0
  return {
    switchMode: vi.fn(async () => ({ ok: true as const })),
    setLeverage: vi.fn(async () => ({ ok: true as const, idempotent: false })),
    createOrder: vi.fn(async (params) => {
      orderSeq += 1
      return { orderId: `ex-order-${orderSeq}`, orderLinkId: params.orderLinkId, ok: true as const, idempotent: false }
    }),
    setTradingStop: vi.fn(async () => ({ ok: true as const })),
    cancelAll: vi.fn(async () => ({ ok: true as const })),
    cancelOrder: vi.fn(async () => ({ ok: true as const })),
  }
}

interface SeedTradeOpts {
  symbol: string
  side: Side
  /** true -> BybitAdapter (orderLinkId 'K...', LIVE для реконсиляции); false -> DryRunAdapter ('D...'). */
  live: boolean
  status?: TradeStatus
  avgEntry?: string
  size?: string
  leverage?: string
  openedAt?: Date
  /** По умолчанию true для open/partially_closed — реалистичный "сделка реально держит символ". */
  acquireOwnership?: boolean
  /** Канал сделки: по умолчанию CHANNEL_ID; OTHER_CHANNEL_ID — «сделка чужого аккаунта». */
  channelId?: number
}

/**
 * Готовит полный локальный след сделки через РЕАЛЬНЫЙ ExecutionPort.placeEntry (не руками) —
 * orderLinkId и его K/D-префикс должны быть настоящими, реконсиляция различает live/dry-run
 * именно по нему (см. topверху файла и reconcile.ts). После вызова порта pipeline.ts ВСЕГДА
 * обновляет trades (status/avg_entry/size/leverage, см. pipeline.ts::handleEntrySignal) — та же
 * последовательность воспроизведена здесь вручную (задача 4 не трогает pipeline.ts).
 */
async function seedTrade(opts: SeedTradeOpts): Promise<{ tradeId: string; humanRef: string; orderLinkId: string }> {
  const channelId = opts.channelId ?? CHANNEL_ID
  const channelOrd = channelId === OTHER_CHANNEL_ID ? OTHER_CHANNEL_ORD : CHANNEL_ORD
  const { messageId, tgMessageId } = await seedMessage(channelId)
  const actionId = await seedAction({ messageId, symbol: opts.symbol, side: opts.side, channelId })
  const trade = await openTrade(db, { channelId, symbol: opts.symbol, side: opts.side })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: opts.size ?? '1' })

  const entryParams = {
    channelId,
    channelOrd,
    tgMessageId,
    actionIndex: 0,
    actionId,
    tradeId: trade.tradeId,
    legId: leg.legId,
    symbol: opts.symbol,
    side: opts.side,
    purpose: 'entry' as const,
    orderType: 'market' as const,
    qty: opts.size ?? '1',
    price: opts.avgEntry ?? '100',
    leverage: opts.leverage ?? '5',
    liqPrice: '1',
  }

  let orderLinkId: string
  if (opts.live) {
    await seedInstrument(opts.symbol)
    const result = await new BybitAdapter(createMockBybitRest(), 'testnet').placeEntry(db, entryParams)
    orderLinkId = result.orderLinkId
  } else {
    const result = await new DryRunAdapter().placeEntry(db, entryParams)
    orderLinkId = result.orderLinkId
  }

  const status = opts.status ?? 'open'
  await db
    .updateTable('trades')
    .set({
      status,
      avg_entry: opts.avgEntry ?? '100',
      size: opts.size ?? '1',
      leverage: opts.leverage ?? '5',
      opened_at: opts.openedAt ?? new Date(),
      ...(status === 'closed' || status === 'cancelled' ? { closed_at: new Date() } : {}),
    })
    .where('id', '=', trade.tradeId)
    .execute()

  if ((opts.acquireOwnership ?? true) && (status === 'open' || status === 'partially_closed')) {
    await acquireSymbol(db, { channelId, symbol: opts.symbol, tradeId: trade.tradeId })
  }

  return { tradeId: trade.tradeId, humanRef: trade.humanRef, orderLinkId }
}

function makePosition(overrides: Partial<Position> & { symbol: string }): Position {
  const now = String(Date.now())
  return {
    side: 'Buy',
    size: '1',
    avgPrice: '100',
    leverage: '5',
    positionIdx: 0,
    tradeMode: 0,
    liqPrice: '1',
    markPrice: '100',
    positionValue: '100',
    unrealisedPnl: '0',
    takeProfit: '0',
    stopLoss: '0',
    positionStatus: 'Normal',
    createdTime: now,
    updatedTime: now,
    seq: 1,
    ...overrides,
  }
}

function makeOrder(overrides: Partial<Order> & { symbol: string; orderLinkId: string }): Order {
  const now = String(Date.now())
  return {
    orderId: 'ex-order-hanging-1',
    side: 'Buy',
    orderType: 'Limit',
    price: '0',
    qty: '0',
    cumExecQty: '0',
    orderStatus: 'New',
    timeInForce: 'GTC',
    reduceOnly: false,
    createdTime: now,
    updatedTime: now,
    ...overrides,
  }
}

function makeRest(
  positions: Position[],
  openOrders: Order[] = [],
  history: { executions?: Execution[]; orders?: Order[]; closedPnl?: ClosedPnl[] } = {},
): { rest: ReconcileRestClient; cancelOrderCalls: Array<{ symbol: string; orderLinkId: string }> } {
  const cancelOrderCalls: Array<{ symbol: string; orderLinkId: string }> = []
  const rest: ReconcileRestClient = {
    getPositions: vi.fn(async () => positions),
    getOpenOrders: vi.fn(async () => openOrders),
    // M1 (Minor адверсариального ревью): реконсиляция теперь умеет отменять осиротевшие
    // reduceOnly-остатки — мок нужен ВСЕМ тестам этого файла, даже тем, что его не проверяют
    // напрямую (без него ReconcileRestClient не удовлетворён типом).
    cancelOrder: vi.fn(async (params: { symbol: string; orderLinkId: string }) => {
      cancelOrderCalls.push(params)
      return { ok: true as const }
    }),
    // Догон истории (исполнения/PnL/статусы ордеров). По умолчанию биржа отдаёт пустую историю —
    // тогда этот блок ничего не меняет, и тесты снапшот-сверки проверяют ровно то же, что и раньше.
    getExecutions: vi.fn(async () => history.executions ?? []),
    getOrderHistory: vi.fn(async () => history.orders ?? []),
    getClosedPnl: vi.fn(async () => history.closedPnl ?? []),
  }
  return { rest, cancelOrderCalls }
}

async function auditLogRows(): Promise<Array<{ action: string; entity_id: string | null }>> {
  const { rows } = await sql<{ action: string; entity_id: string | null }>`
    SELECT action, entity_id FROM audit_log WHERE actor = 'reconcileOnStart' ORDER BY id
  `.execute(db)
  return rows
}

describe('reconcileOnStart', () => {
  it('позиция на бирже без атрибуции в журнале -> flagged, канал не угадывается (audit_log)', async () => {
    const { rest } = makeRest([makePosition({ symbol: 'UNKNOWNUSDT', side: 'Buy', size: '10' })])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 1, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const audit = await auditLogRows()
    expect(audit).toEqual([{ action: 'unknown_position', entity_id: 'UNKNOWNUSDT' }])

    // никакая trades-строка не создана вслепую (channel_id NOT NULL — угадать канал нельзя).
    const count = await db
      .selectFrom('trades')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('symbol', '=', 'UNKNOWNUSDT')
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(0)
  })

  it('позиция атрибутирована по orderLinkId висящего ордера -> opened, статус/владение восстановлены', async () => {
    // Локальная сделка уже 'closed' в журнале (напр. крэш/рассинхрон), но её ЖИВОЙ ордер всё
    // ещё висит на бирже (order/realtime) — атрибуция по orderLinkId должна её реанимировать.
    const seeded = await seedTrade({ symbol: 'ATTRUSDT', side: 'long', live: true, status: 'closed', acquireOwnership: false })

    const { rest } = makeRest(
      [makePosition({ symbol: 'ATTRUSDT', side: 'Buy', size: '20', avgPrice: '150', leverage: '7' })],
      [makeOrder({ symbol: 'ATTRUSDT', orderLinkId: seeded.orderLinkId })],
    )

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 1, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open')
    expect(trade.closed_at).toBeNull()
    expect(new Decimal(trade.avg_entry!).toString()).toBe('150')
    expect(new Decimal(trade.size).toString()).toBe('20')

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'ATTRUSDT')
      .executeTakeFirstOrThrow()
    expect(position.trade_id).toBe(seeded.tradeId)
    expect(new Decimal(position.size).toString()).toBe('20')

    const ownership = await db
      .selectFrom('symbol_ownership')
      .selectAll()
      .where('trade_id', '=', seeded.tradeId)
      .where('released_at', 'is', null)
      .executeTakeFirst()
    expect(ownership).toBeDefined()
  })

  it("TR открыт в журнале без позиции на бирже -> closed по бирже; dry-run сделка НЕ трогается", async () => {
    // openedAt заведомо СТАРШЕ recency-гейта F2 (снапшот getPositions) — иначе свежая сделка была
    // бы защищена от закрытия (см. отдельный блок F2/F8 ниже); здесь проверяем именно устаревшую.
    const live = await seedTrade({ symbol: 'CLOSEUSDT', side: 'long', live: true, status: 'open', openedAt: new Date(Date.now() - 10 * 60_000) })
    const dryRun = await seedTrade({ symbol: 'DRYUSDT', side: 'long', live: false, status: 'open' })

    const { rest } = makeRest([]) // на бирже вообще ничего не открыто

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 1, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const liveTrade = await db.selectFrom('trades').selectAll().where('id', '=', live.tradeId).executeTakeFirstOrThrow()
    expect(liveTrade.status).toBe('closed')
    expect(liveTrade.closed_at).not.toBeNull()

    const liveOwnership = await db
      .selectFrom('symbol_ownership')
      .select('released_at')
      .where('trade_id', '=', live.tradeId)
      .executeTakeFirstOrThrow()
    expect(liveOwnership.released_at).not.toBeNull()

    // dry-run сделка: НЕТ 'K'-ордера -> вне поля зрения LIVE-реконсиляции целиком, статус
    // не тронут, несмотря на то, что на бирже её символа тоже "нет" — она никогда там и не была.
    const dryTrade = await db.selectFrom('trades').selectAll().where('id', '=', dryRun.tradeId).executeTakeFirstOrThrow()
    expect(dryTrade.status).toBe('open')
    expect(dryTrade.closed_at).toBeNull()
  })

  it('совпадение symbol -> синхронизация size/avg_price/leverage/liq из биржи, статус НЕ меняется', async () => {
    const seeded = await seedTrade({
      symbol: 'SYNCUSDT',
      side: 'long',
      live: true,
      status: 'open',
      avgEntry: '100',
      size: '10',
      leverage: '5',
      openedAt: new Date(Date.now() - 5_000),
    })

    const { rest } = makeRest([
      makePosition({
        symbol: 'SYNCUSDT',
        side: 'Buy',
        size: '12',
        avgPrice: '105',
        leverage: '6',
        liqPrice: '80',
        createdTime: String(Date.now()),
      }),
    ])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open') // статус не тронут
    expect(new Decimal(trade.avg_entry!).toString()).toBe('105')
    expect(new Decimal(trade.size).toString()).toBe('12')
    expect(new Decimal(trade.leverage!).toString()).toBe('6')

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'SYNCUSDT')
      .executeTakeFirstOrThrow()
    expect(new Decimal(position.avg_price!).toString()).toBe('105')
    expect(new Decimal(position.liq_price!).toString()).toBe('80')
    expect(position.trade_id).toBe(seeded.tradeId)
  })

  it('ЧУЖАЯ позиция (не трогали задолго до нашего opened_at, наших ордеров на символе нет) -> НЕ синкается, флагуется', async () => {
    const openedAt = new Date()
    const seeded = await seedTrade({
      symbol: 'OLDUSDT',
      side: 'long',
      live: true,
      status: 'open',
      avgEntry: '50',
      size: '1',
      openedAt,
    })

    const { rest } = makeRest([
      makePosition({
        symbol: 'OLDUSDT',
        side: 'Buy',
        size: '99',
        avgPrice: '999',
        // Позицию не трогали за 10 минут до нашего входа — наш вход её не создавал: ручная/
        // пред-существующая "чужая" позиция (research §14). Бэкдейтим ОБА поля: createdTime сам по
        // себе ничего не доказывает (Bybit переиспользует слот символа), решает updatedTime.
        createdTime: String(openedAt.getTime() - 10 * 60_000),
        updatedTime: String(openedAt.getTime() - 10 * 60_000),
      }),
    ])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 1, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open') // не закрыт — позиция формально существует на символе
    expect(new Decimal(trade.avg_entry!).toString()).toBe('50') // НЕ перезаписан "чужими" 999

    const audit = await auditLogRows()
    expect(audit.map((r) => r.action)).toEqual(['ambiguous_position'])
  })

  // Регрессия «позиция не видна в UI» (13.07.2026): Bybit НЕ сбрасывает position.createdTime при
  // закрытии/повторном открытии — это водяной знак СЛОТА символа, а не текущей позиции. Старый гейт
  // сравнивал его с opened_at, поэтому КАЖДЫЙ повторный вход по уже торговавшемуся символу уходил в
  // ambiguous и не попадал в `positions` → позиция невидима в админке И неуправляема из канала
  // (pipeline резолвит сделку для дельт через positions.size <> 0).
  it('повторный вход по уже торговавшемуся символу (createdTime — старый слот Bybit, updatedTime свежий) -> позиция НАША, синкается', async () => {
    const openedAt = new Date()
    const seeded = await seedTrade({
      symbol: 'REPEATUSDT',
      side: 'long',
      live: true,
      status: 'open',
      avgEntry: '50',
      size: '1',
      openedAt,
    })

    const { rest } = makeRest([
      makePosition({
        symbol: 'REPEATUSDT',
        side: 'Buy',
        size: '0.1',
        avgPrice: '76.41',
        // Слот символа заведён двое суток назад (первая в истории сделка по нему)...
        createdTime: String(openedAt.getTime() - 2 * 24 * 3600_000),
        // ...а филл НАШЕГО входа случился за 245 мс до коммита нашей строки (биржа исполняет ордер
        // ещё внутри транзакции pipeline).
        updatedTime: String(openedAt.getTime() - 245),
      }),
    ])

    // openOrders пуст намеренно: проверяем именно таймстемп-путь, а не подтверждение по orderLinkId.
    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('symbol', '=', 'REPEATUSDT')
      .executeTakeFirstOrThrow()
    expect(new Decimal(position.size).toString()).toBe('0.1')
    expect(position.trade_id).toBe(seeded.tradeId)
  })

  it('orderLinkId сильнее таймстемпа: единственный кандидат со СТАРЫМ updatedTime, но на символе висит наш ордер этой сделки -> синкается', async () => {
    const openedAt = new Date()
    const seeded = await seedTrade({
      symbol: 'LINKEDUSDT',
      side: 'long',
      live: true,
      status: 'open',
      avgEntry: '50',
      size: '1',
      openedAt,
    })

    const { rest } = makeRest(
      [
        makePosition({
          symbol: 'LINKEDUSDT',
          side: 'Buy',
          size: '2',
          avgPrice: '60',
          // Таймстемп-гейт сказал бы «чужая»...
          createdTime: String(openedAt.getTime() - 10 * 60_000),
          updatedTime: String(openedAt.getTime() - 10 * 60_000),
        }),
      ],
      // ...но на символе висит НАШ ордер именно этой сделки — детерминированное доказательство владения.
      [makeOrder({ symbol: 'LINKEDUSDT', orderLinkId: seeded.orderLinkId })],
    )

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('symbol', '=', 'LINKEDUSDT')
      .executeTakeFirstOrThrow()
    expect(new Decimal(position.size).toString()).toBe('2')
    expect(position.trade_id).toBe(seeded.tradeId)
  })

  // Блокер, вскрытый на живой позиции: Bybit отдаёт ПУСТУЮ СТРОКУ вместо числа (liqPrice="" у
  // cross-позиции без риска ликвидации). `''::numeric` в Postgres — ошибка, которая рвала ВСЮ
  // транзакцию реконсиляции, а на старте (reconcileOnStart вызывается без catch) положила бы движок
  // в boot-loop — ровно в тот момент, когда гейт выше начал бы до этой строки доходить.
  it('пустые числовые поля биржи (liqPrice="", markPrice="", takeProfit="") -> upsert не падает, поля NULL', async () => {
    const openedAt = new Date()
    const seeded = await seedTrade({
      symbol: 'EMPTYUSDT',
      side: 'long',
      live: true,
      status: 'open',
      avgEntry: '50',
      size: '1',
      openedAt,
    })

    const { rest } = makeRest([
      makePosition({
        symbol: 'EMPTYUSDT',
        side: 'Buy',
        size: '0.1',
        avgPrice: '76.41',
        liqPrice: '',
        markPrice: '',
        takeProfit: '',
        stopLoss: '72.59',
        updatedTime: String(openedAt.getTime() - 245),
      }),
    ])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('symbol', '=', 'EMPTYUSDT')
      .executeTakeFirstOrThrow()
    expect(position.liq_price).toBeNull()
    expect(position.take_profit).toBeNull()
    expect(position.trade_id).toBe(seeded.tradeId)
    // SL биржи доезжает до карточки — иначе оператор увидит «—» при реально выставленном стопе.
    expect(new Decimal(position.stop_loss!).toString()).toBe('72.59')
  })
})

const BYBIT_LIVE_TESTS = process.env.BYBIT_LIVE_TESTS === '1'
if (!BYBIT_LIVE_TESTS) {
  console.warn('[reconcile.test] живой Bybit-тест пропущен; задайте BYBIT_LIVE_TESTS=1 для запуска (ходит на testnet)')
}
const describeLive = BYBIT_LIVE_TESTS ? describe : describe.skip

describeLive('reconcileOnStart (живой testnet) — требует BYBIT_LIVE_TESTS=1', () => {
  it('пустой аккаунт (позиций нет) + пустой локальный журнал -> {opened:0, closed:0, flagged:0}', async () => {
    const apiKey = process.env.BYBIT_API_KEY
    const apiSecret = process.env.BYBIT_API_SECRET
    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_LIVE_TESTS=1, но BYBIT_API_KEY/BYBIT_API_SECRET не заданы в .env')
    }
    const network = process.env.BYBIT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    const client = new BybitRestClient({ apiKey, apiSecret, network })

    const result = await reconcileOnStart(db, client)
    console.log('[live] reconcileOnStart() =', JSON.stringify(result))
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })
  })
})

describe('reconcileOnStart — M1 (Minor адверсариального ревью): осиротевшие reduceOnly-остатки', () => {
  it('reduceOnly-ордер (TP/SL/close) по символу БЕЗ открытой позиции -> отменяется (orphansCancelled); entry/add того же типа НЕ трогается', async () => {
    const { rest, cancelOrderCalls } = makeRest(
      [], // на бирже открытых позиций нет вовсе
      [
        makeOrder({ symbol: 'ORPHANUSDT', orderLinkId: 'K01-1-00-T0', reduceOnly: true, orderType: 'Limit' }),
        // Легитимная отложенная лимитка (entry) того же "бессимвольного" положения — reduceOnly
        // не выставлен, TTL/cancel_pending её ведение — НЕ забота M1, эта ветка не должна её трогать.
        makeOrder({ symbol: 'ORPHANUSDT', orderLinkId: 'K01-1-00-E0', reduceOnly: false, orderType: 'Limit' }),
      ],
    )

    const result = await reconcileOnStart(db, rest)

    expect(result.orphansCancelled).toBe(1)
    expect(cancelOrderCalls).toEqual([{ symbol: 'ORPHANUSDT', orderLinkId: 'K01-1-00-T0' }])
  })

  it('reduceOnly-ордер символа С открытой позицией на бирже -> НЕ трогается (легитимный TP/SL живой позиции)', async () => {
    const { rest, cancelOrderCalls } = makeRest(
      [makePosition({ symbol: 'LIVEUSDT', side: 'Buy', size: '5' })],
      [makeOrder({ symbol: 'LIVEUSDT', orderLinkId: 'K01-2-00-S0', reduceOnly: true, orderType: 'Limit' })],
    )

    const result = await reconcileOnStart(db, rest)

    expect(result.orphansCancelled).toBe(0)
    expect(cancelOrderCalls).toEqual([])
  })

  it('cancelOrder на бирже бросает -> залогировано, не роняет reconcileOnStart, счётчик не инкрементится для этого ордера', async () => {
    const { rest } = makeRest(
      [],
      [makeOrder({ symbol: 'FAILUSDT', orderLinkId: 'K01-3-00-T0', reduceOnly: true, orderType: 'Limit' })],
    )
    vi.mocked(rest.cancelOrder).mockRejectedValueOnce(new Error('network boom'))

    const result = await reconcileOnStart(db, rest)

    expect(result.orphansCancelled).toBe(0)
  })
})

// F2/F8 (адверсариальное ревью): getPositions() читается ДО транзакции (снапшот T0), а localLiveTrades
// — внутри неё (READ COMMITTED). Сделку, только что открытую параллельным пайплайном (opened_at>T0),
// снапшот не застал -> без recency-гейта шаг Б закрыл бы её без close-ордера (осиротив живую позицию),
// а шаг Г снял бы её защитный reduceOnly. Гейт (tradeOpenedAfterSnapshot, ТА ЖЕ CREATED_TIME_TOLERANCE_MS,
// что и createdTime-защита шага А) пропускает свежие сделки и продолжает закрывать/чистить устаревшие.
describe('reconcileOnStart — F2/F8 (адверсариальное ревью): recency-гейт против устаревшего снапшота', () => {
  it('F2: свежая LIVE-сделка (opened_at ~ сейчас) без позиции на бирже -> НЕ закрывается (снапшот T0 мог её не застать)', async () => {
    const fresh = await seedTrade({ symbol: 'FRESHUSDT', side: 'long', live: true, status: 'open', openedAt: new Date() })

    const { rest } = makeRest([]) // на бирже пусто — но сделка только что открыта параллельным пайплайном

    const result = await reconcileOnStart(db, rest)
    expect(result.closed).toBe(0)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', fresh.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open')
    expect(trade.closed_at).toBeNull()
  })

  it('F2: реально УСТАРЕВШАЯ LIVE-сделка (opened_at 10 мин назад) без позиции на бирже -> закрывается по бирже', async () => {
    const stale = await seedTrade({
      symbol: 'STALEUSDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })

    const { rest } = makeRest([])

    const result = await reconcileOnStart(db, rest)
    expect(result.closed).toBe(1)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', stale.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('closed')
    expect(trade.closed_at).not.toBeNull()
  })

  it('F8: reduceOnly-остаток символа СВЕЖЕЙ LIVE-сделки -> НЕ отменяется (защитный TP только что открытой позиции, лаг биржи)', async () => {
    const fresh = await seedTrade({ symbol: 'FRESHTPUSDT', side: 'long', live: true, status: 'open', openedAt: new Date() })

    const { rest, cancelOrderCalls } = makeRest(
      [], // позиция ещё не попала в снапшот getPositions(T0)
      [makeOrder({ symbol: 'FRESHTPUSDT', orderLinkId: 'K01-9-00-T0', reduceOnly: true, orderType: 'Limit' })],
    )

    const result = await reconcileOnStart(db, rest)

    expect(result.orphansCancelled).toBe(0)
    expect(cancelOrderCalls).toEqual([])
    // и сама свежая сделка не закрыта (F2, симметрично)
    const trade = await db.selectFrom('trades').selectAll().where('id', '=', fresh.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open')
  })

  it('F8: reduceOnly-остаток символа УСТАРЕВШЕЙ LIVE-сделки без позиции -> отменяется (реальный осиротевший TP)', async () => {
    await seedTrade({
      symbol: 'STALETPUSDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })

    const { rest, cancelOrderCalls } = makeRest(
      [],
      [makeOrder({ symbol: 'STALETPUSDT', orderLinkId: 'K01-8-00-T0', reduceOnly: true, orderType: 'Limit' })],
    )

    const result = await reconcileOnStart(db, rest)

    expect(result.orphansCancelled).toBe(1)
    expect(cancelOrderCalls).toEqual([{ symbol: 'STALETPUSDT', orderLinkId: 'K01-8-00-T0' }])
  })
})

// I1 (Important финального ревью Ф3): гонка атрибуции executions -> realized_pnl занижается
// безвозвратно. Market-ордер уходит на биржу ВНУТРИ ещё не закоммиченной транзакции
// pipeline.ts::placeEntry/closePosition — исполнение занимает миллисекунды, приватный WS
// (applyExecutionPush, ОТДЕЛЬНОЕ соединение, READ COMMITTED) не видит незакоммиченную строку
// `orders` -> вставляет execution "осиротевшим" (order_id/trade_id/leg_id=null), который НИКОГДА
// не попадает в SUM(exec_pnl) при пересчёте trades.realized_pnl. К моменту reconcileOnStart (10
// мин интервал, main.ts) строка orders уже точно закоммичена — переатрибуция по order_link_id
// самоисцеляет журнал в пределах этого окна.
describe('reconcileOnStart — I1 (Important финального ревью Ф3): переатрибуция осиротевших execution', () => {
  it('execution с order_link_id существующего ордера, но order_id=null -> привязан к order/trade/leg, realized_pnl сделки пересчитан; повторный reconcile идемпотентен', async () => {
    const seeded = await seedTrade({ symbol: 'ORPHEXECUSDT', side: 'long', live: true, status: 'closed', acquireOwnership: false })

    const orderRow = await db
      .selectFrom('orders')
      .select(['id', 'trade_id', 'leg_id'])
      .where('order_link_id', '=', seeded.orderLinkId)
      .executeTakeFirstOrThrow()

    await db
      .insertInto('executions')
      .values({
        order_id: null,
        trade_id: null,
        leg_id: null,
        bybit_exec_id: 'exec-orphan-1',
        order_link_id: seeded.orderLinkId,
        symbol: 'ORPHEXECUSDT',
        side: 'long',
        exec_qty: '1',
        exec_price: '100',
        exec_pnl: '12.5',
        exec_ts: new Date(),
      })
      .execute()

    const { rest } = makeRest([]) // позиций на бирже нет — трогает только Шаг В (переатрибуция), не А/Б

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 1 })

    const execution = await db
      .selectFrom('executions')
      .selectAll()
      .where('bybit_exec_id', '=', 'exec-orphan-1')
      .executeTakeFirstOrThrow()
    expect(execution.order_id).toBe(orderRow.id)
    expect(execution.trade_id).toBe(seeded.tradeId)
    expect(execution.leg_id).toBe(orderRow.leg_id)

    const trade = await db.selectFrom('trades').select('realized_pnl').where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(new Decimal(trade.realized_pnl).toString()).toBe('12.5')

    // Идемпотентность: повторный reconcile не ломает уже привязанные строки (WHERE order_id IS
    // NULL исключает их) — счётчик 0, realized_pnl не портится повторным пересчётом.
    const second = await reconcileOnStart(db, rest)
    expect(second).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })

    const tradeAfterSecond = await db.selectFrom('trades').select('realized_pnl').where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(new Decimal(tradeAfterSecond.realized_pnl).toString()).toBe('12.5')
  })
})

describe('reconcileOnStart — шаг Б2: фантомные строки зеркала', () => {
  it('зануляет зеркало ЗАКРЫТОЙ сделки, если позиции на бирже нет (потерянный пуш WS)', async () => {
    // Живой e2e (3 прогона из 5): пайплайн закрыл сделку сам, а финальный пуш `position size=0`
    // до зеркала не дошёл — строка осталась с прежним размером. Шаг Б её не видел (он чинит
    // только ОТКРЫТЫЕ сделки), и оператор навсегда видел в UI позицию, которой на бирже нет;
    // handleDelta (ищет сделку по `positions.size <> 0`) мог начать ею «управлять».
    const symbol = 'PHANTOM1USDT'
    const { tradeId } = await seedTrade({ symbol, side: 'long', live: true, status: 'closed' })
    await db
      .insertInto('positions')
      .values({
        channel_id: CHANNEL_ID,
        symbol,
        trade_id: tradeId,
        side: 'long',
        size: '3',
        avg_price: '100',
        bybit_seq: 7,
        // Строка старше снапшота: реконсиляция не имеет права трогать то, что WS узнал позже.
        updated_at: new Date(Date.now() - 60_000),
      })
      // DryRunAdapter уже мог создать строку зеркала при входе — тест интересует её СОСТОЯНИЕ,
      // а не факт вставки.
      .onConflict((oc) =>
        oc.columns(['channel_id', 'symbol']).doUpdateSet((eb) => ({
          size: eb.ref('excluded.size'),
          side: eb.ref('excluded.side'),
          trade_id: eb.ref('excluded.trade_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()

    const result = await reconcileOnStart(db, makeRest([]).rest)

    expect(result.phantomsZeroed).toBe(1)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('0.0000000000')
  })

  it('НЕ трогает зеркало dry-run-сделки — у неё на бирже ничего и не было', async () => {
    const symbol = 'PHANTOM2USDT'
    const { tradeId } = await seedTrade({ symbol, side: 'long', live: false, status: 'closed' })
    await db
      .insertInto('positions')
      .values({
        channel_id: CHANNEL_ID,
        symbol,
        trade_id: tradeId,
        side: 'long',
        size: '5',
        avg_price: '10',
        updated_at: new Date(Date.now() - 60_000),
      })
      // DryRunAdapter уже мог создать строку зеркала при входе — тест интересует её СОСТОЯНИЕ,
      // а не факт вставки.
      .onConflict((oc) =>
        oc.columns(['channel_id', 'symbol']).doUpdateSet((eb) => ({
          size: eb.ref('excluded.size'),
          side: eb.ref('excluded.side'),
          trade_id: eb.ref('excluded.trade_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()

    const result = await reconcileOnStart(db, makeRest([]).rest)

    expect(result.phantomsZeroed).toBe(0)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('5.0000000000')
  })

  it('НЕ трогает зеркало ЧУЖОГО канала: его позиция живёт на другом аккаунте, эта биржа о ней и не знает', async () => {
    const symbol = 'PHANTOM4USDT'
    const { tradeId } = await seedTrade({ channelId: OTHER_CHANNEL_ID, symbol, side: 'long', live: true, status: 'closed' })
    await db
      .insertInto('positions')
      .values({
        channel_id: OTHER_CHANNEL_ID,
        symbol,
        trade_id: tradeId,
        side: 'long',
        size: '4',
        avg_price: '100',
        updated_at: new Date(Date.now() - 60_000),
      })
      .onConflict((oc) =>
        oc.columns(['channel_id', 'symbol']).doUpdateSet((eb) => ({
          size: eb.ref('excluded.size'),
          side: eb.ref('excluded.side'),
          trade_id: eb.ref('excluded.trade_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()

    const result = await reconcileOnStart(db, makeRest([]).rest, { channelIds: [CHANNEL_ID] })

    expect(result.phantomsZeroed).toBe(0)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', OTHER_CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('4.0000000000')
  })

  it('НЕ трогает зеркало, обновлённое ПОЗЖЕ снапшота биржи (WS знает свежее)', async () => {
    const symbol = 'PHANTOM3USDT'
    const { tradeId } = await seedTrade({ symbol, side: 'long', live: true, status: 'closed' })
    await db
      .insertInto('positions')
      .values({
        channel_id: CHANNEL_ID,
        symbol,
        trade_id: tradeId,
        side: 'long',
        size: '2',
        avg_price: '9',
        // Свежее момента снапшота: позиция могла открыться уже ПОСЛЕ того, как мы спросили биржу.
        updated_at: new Date(Date.now() + 60_000),
      })
      // DryRunAdapter уже мог создать строку зеркала при входе — тест интересует её СОСТОЯНИЕ,
      // а не факт вставки.
      .onConflict((oc) =>
        oc.columns(['channel_id', 'symbol']).doUpdateSet((eb) => ({
          size: eb.ref('excluded.size'),
          side: eb.ref('excluded.side'),
          trade_id: eb.ref('excluded.trade_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .execute()

    const result = await reconcileOnStart(db, makeRest([]).rest)

    expect(result.phantomsZeroed).toBe(0)
    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', symbol)
      .executeTakeFirstOrThrow()
    expect(row.size).toBe('2.0000000000')
  })
})

// Субаккаунты (docs/superpowers/specs/2026-07-26-per-channel-subaccounts-design.md): у каждого
// канала может быть СВОЙ аккаунт Bybit, и сверка запускается ОТДЕЛЬНО на каждый аккаунт своим
// rest-клиентом. Без скоупа по каналам сверка аккаунта A увидела бы «сделки канала B без позиции
// на бирже» (позиции B лежат на аккаунте B, этот клиент их не видит) и закрыла бы их — то есть
// потушила бы живые чужие сделки. Это самое опасное место задачи, поэтому оно закреплено тестами.
describe('reconcileOnStart — скоуп по каналам аккаунта (субаккаунты)', () => {
  it('сверка аккаунта одного канала НЕ закрывает устаревшую сделку чужого канала', async () => {
    const mine = await seedTrade({
      symbol: 'SCOPEMINEUSDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })
    const other = await seedTrade({
      channelId: OTHER_CHANNEL_ID,
      symbol: 'SCOPEOTHERUSDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })

    // Аккаунт канала 1: на бирже пусто. Позиция канала 2 живёт на ДРУГОМ аккаунте.
    const result = await reconcileOnStart(db, makeRest([]).rest, { channelIds: [CHANNEL_ID] })

    expect(result.closed).toBe(1)
    const mineRow = await db.selectFrom('trades').selectAll().where('id', '=', mine.tradeId).executeTakeFirstOrThrow()
    expect(mineRow.status).toBe('closed')
    const otherRow = await db.selectFrom('trades').selectAll().where('id', '=', other.tradeId).executeTakeFirstOrThrow()
    expect(otherRow.status).toBe('open')
    expect(otherRow.closed_at).toBeNull()
  })

  it('вызов БЕЗ скоупа (общий аккаунт из env) по-прежнему сверяет все каналы — поведение до задачи', async () => {
    await seedTrade({ symbol: 'SHARED1USDT', side: 'long', live: true, status: 'open', openedAt: new Date(Date.now() - 10 * 60_000) })
    await seedTrade({
      channelId: OTHER_CHANNEL_ID,
      symbol: 'SHARED2USDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })

    const result = await reconcileOnStart(db, makeRest([]).rest)

    expect(result.closed).toBe(2)
  })

  it('аккаунт БЕЗ каналов (все ключи канала отвалились) не закрывает ничего чужого', async () => {
    const other = await seedTrade({
      channelId: OTHER_CHANNEL_ID,
      symbol: 'SCOPEEMPTYUSDT',
      side: 'long',
      live: true,
      status: 'open',
      openedAt: new Date(Date.now() - 10 * 60_000),
    })

    // Пустой список каналов — НЕ то же самое, что «скоуп не задан»: сверять нечего.
    const result = await reconcileOnStart(db, makeRest([]).rest, { channelIds: [] })

    expect(result.closed).toBe(0)
    const row = await db.selectFrom('trades').selectAll().where('id', '=', other.tradeId).executeTakeFirstOrThrow()
    expect(row.status).toBe('open')
  })
})
