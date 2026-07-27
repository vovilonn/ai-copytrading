import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Kysely } from 'kysely'
import { Decimal } from 'decimal.js'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { createExecutionPort, type ExecutionPort } from '../src/execution/port.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from '../src/pipeline.js'
import { createMarkPriceGetter, type MarkPriceRestClient } from '../src/main.js'

/**
 * Юнит/интеграционные тесты пайплайна на два денежных инварианта, найденных адверсариальным
 * ревью денежного ядра (безопасны в dry-run, но денежные баги в live):
 *
 * Important #1 — «ликвидация за стопом»: SL обязан быть на правильной СТОРОНЕ входа и строго
 * ЗА ценой ликвидации выбранного плеча (handleEntrySignal, apps/engine/src/pipeline.ts).
 * Important #2 — channel_settings.enabled=false обязан гасить ЛЮБОЕ исполнение (ни одного
 * orders/trades/positions), даже если сообщение успешно распарсилось.
 *
 * Полный property-свип d=0.001..0.999 для инварианта #1 — отдельный временный скрипт
 * (см. p1-core-fix-report.md), не часть постоянного набора тестов (он бы дублировал уже
 * существующий property-тест apps/engine/test/leverage.test.ts на уровне chistoй функции).
 */

let db: Kysely<DB>
// aiEnabled: false — с переходом на «AI читает каждое сообщение» пайплайн иначе дёргал бы платный
// ai-proxy по сети на КАЖДОМ прогоне этого файла (таймауты вместо ассертов, счёт за тесты). Здесь
// проверяется исполнение детерминированного разбора; слияние с AI живёт в reconciler.test.ts.
const deps: PipelineDeps = {
  executionPort: createExecutionPort('dry_run'),
  network: 'testnet',
  equity: '1000',
  aiEnabled: false,
}

// Диапазон id заведомо не пересекается с реальными Telegram channel id (используемыми в
// pipeline.e2e.test.ts/ch1.adapter.test.ts) — resetTestSchema чистит БД перед каждым тестом,
// но разные тесты внутри одного it() всё равно должны получать разные PK.
let nextChannelId = 910_000_001

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
})

interface SeedOpts {
  channelId: number
  symbol: string
  enabled?: boolean
  tradeSize?: string
  qtyStep?: string
  /** 'ch2-freeform' — канал свободного текста (market_entry/limit_entry/add рождаются только там). */
  adapterId?: string
  defaultLeverage?: string | null
  maxLeverage?: string
  /** Водяной знак истории канала: сообщения с tg_message_id <= него движок не разбирает. */
  processFromMessageId?: number
}

async function seedChannel(opts: SeedOpts): Promise<void> {
  const now = new Date()
  await db
    .insertInto('channels')
    .values({
      id: opts.channelId,
      ord: 1,
      key: `ch-${opts.channelId}`,
      source_kind: 'channel',
      topic_id: null,
      adapter_id: opts.adapterId ?? 'ch1-structured',
      title: null,
      handle: null,
      status: 'active',
      last_seen_message_id: 0,
      process_from_message_id: opts.processFromMessageId ?? 0,
      bybit_sub_uid: null,
      bybit_api_key_enc: null,
      bybit_api_secret_enc: null,
      created_at: now,
      updated_at: now,
    })
    .execute()

  await db
    .insertInto('channel_settings')
    .values({
      channel_id: opts.channelId,
      enabled: opts.enabled ?? true,
      trade_size: opts.tradeSize ?? '500',
      max_leverage: opts.maxLeverage ?? '50',
      default_leverage: opts.defaultLeverage ?? null,
      cross_margin: true,
      no_sl_policy: 'attach_protective_sl',
      no_sl_buffer_sec: 0,
      add_sizing_mode: 'trade_size',
      mirror_manual_fraction: false,
      limit_ttl_sec: 604_800,
      updated_at: now,
    })
    .execute()

  await db
    .insertInto('instruments')
    .values({
      symbol: opts.symbol,
      network: 'testnet',
      base_coin: opts.symbol.replace(/USDT$/, ''),
      status: 'Trading',
      qty_step: opts.qtyStep ?? '0.01',
      min_qty: opts.qtyStep ?? '0.01',
      tick_size: '0.0001',
      min_notional: '5',
      max_leverage: '50',
      leverage_step: '0.01',
      mmr: '0.005',
      refreshed_at: now,
    })
    .execute()
}

async function insertMessage(channelId: number, tgMessageId: number, text: string): Promise<PipelineMessage> {
  const msgTs = new Date()
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: channelId,
      tg_message_id: tgMessageId,
      reply_to_msg_id: null,
      grouped_id: null,
      is_topic_message: false,
      text,
      has_media: false,
      media_kind: null,
      msg_ts: msgTs,
      raw: JSON.stringify({ id: tgMessageId, text }),
      status: 'received',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    id: row.id,
    channelId,
    tgMessageId,
    replyToMsgId: null,
    groupedId: null,
    text,
    mediaKind: null,
    msgTs,
  }
}

async function actionFor(channelId: number, tgMessageId: number) {
  const message = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', channelId)
    .where('tg_message_id', '=', tgMessageId)
    .executeTakeFirstOrThrow()
  return db
    .selectFrom('actions')
    .selectAll()
    .where('message_id', '=', message.id)
    .where('action_index', '=', 0)
    .executeTakeFirstOrThrow()
}

/**
 * Спай над DryRunAdapter (Critical C1 адверсариального ревью, p3-core-fix-report.md): записывает
 * порядок/содержание вызовов ExecutionPort, реальную работу делегирует DryRunAdapter — так тест
 * проверяет ИМЕННО то, что pipeline.ts вызывает (stopLoss в placeEntry, ни одного отдельного
 * setStopLoss для исходного входа), независимо от того, какой реальный адаптер это исполняет.
 */
function createRecordingExecutionPort(): { port: ExecutionPort; calls: string[] } {
  const inner = new DryRunAdapter()
  const calls: string[] = []
  const port: ExecutionPort = {
    cancelAllForSymbol: (symbol) => {
      calls.push(`cancelAllForSymbol:${symbol}`)
      return inner.cancelAllForSymbol(symbol)
    },
    placeEntry: (tx, order) => {
      calls.push(`placeEntry:stopLoss=${order.stopLoss ?? 'none'}`)
      return inner.placeEntry(tx, order)
    },
    placeTpLadder: (tx, params) => {
      calls.push('placeTpLadder')
      return inner.placeTpLadder(tx, params)
    },
    setStopLoss: (tx, params) => {
      calls.push('setStopLoss')
      return inner.setStopLoss(tx, params)
    },
    closePosition: (tx, params) => {
      calls.push('closePosition')
      return inner.closePosition(tx, params)
    },
    cancelOrder: (tx, params) => {
      calls.push('cancelOrder')
      return inner.cancelOrder(tx, params)
    },
  }
  return { port, calls }
}

describe('pipeline — Critical C1: SL атомарно со входом (не отдельным вызовом после TP-лесенки)', () => {
  it('entry_signal без TP -> placeEntry(stopLoss=SL сигнала), setStopLoss НЕ вызывается отдельно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }
    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    expect(calls).toEqual(['placeEntry:stopLoss=90'])

    // Локальная orders(purpose='sl')-строка всё равно существует (записана АТОМАРНО внутри
    // placeEntry, а не отдельным вызовом) — SL реально применён, не потерян вместе с рефакторингом.
    const slOrder = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'sl').executeTakeFirstOrThrow()
    expect(slOrder.price).toBe('90.0000000000')
    expect(slOrder.reduce_only).toBe(true)

    const position = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).where('symbol', '=', 'ATOMUSDT').executeTakeFirstOrThrow()
    expect(position.stop_loss).toBe('90.0000000000')
  })

  it('нормальный сигнал с TP-лесенкой (LIT short, реальный дамп CH1) -> placeEntry(stopLoss=...) -> placeTpLadder, setStopLoss НЕ вызывается', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LITUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }
    const text = '#LIT/USDT 📉 SHORT\n\nДиапазон входа: 1.5273-1.4735$\nTP: 1.4428$ - 1.3926$ - 1.2777$\nSL: 1.7137$\n\nРиск: 2%'
    const message = await insertMessage(channelId, 2796, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 2796)
    expect(action.status).toBe('executed')

    expect(calls).toEqual(['placeEntry:stopLoss=1.7137', 'placeTpLadder'])
    expect(calls.includes('setStopLoss')).toBe(false)
  })
})

describe('pipeline — гейт безопасного стопа (Important #1)', () => {
  it('long entry=100 sl=0.4 (корректная сторона, но лев клампится к 1x и liq=0.5 > sl=0.4) -> skip unsafe_stop', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'AAAUSDT' })
    const text = '#AAA/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 0.4$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('unsafe_stop')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
    const positions = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).execute()
    expect(positions).toHaveLength(0)
  })

  it('long entry=100 sl=200 (SL выше входа для лонга — неверная сторона) -> skip invalid_sl_side', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'BBBUSDT' })
    const text = '#BBB/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 200$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('invalid_sl_side')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
  })

  it('нормальный сигнал (LIT short, реальное сообщение #2796 дампа CH1) -> исполняется', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LITUSDT' })
    const text = '#LIT/USDT 📉 SHORT\n\nДиапазон входа: 1.5273-1.4735$\nTP: 1.4428$ - 1.3926$ - 1.2777$\nSL: 1.7137$\n\nРиск: 2%'
    const message = await insertMessage(channelId, 2796, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 2796)
    expect(action.status).toBe('executed')
    expect(action.trade_id).not.toBeNull()

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
    // Decimal-точная середина диапазона (1.5273+1.4735)/2=1.5004 (Minor #3 — не JS-float).
    // NUMERIC(30,10) в Postgres возвращает значение с полным масштабом колонки — сравниваем
    // через Decimal, а не строкой, чтобы не зависеть от количества хвостовых нулей.
    expect(new Decimal(trades[0]?.avg_entry ?? '0').toString()).toBe('1.5004')

    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders.length).toBeGreaterThan(0)
  })
})

describe('pipeline — channel_settings.enabled (Important #2)', () => {
  // Решение заказчика (26.07.2026, после инцидента на $22.73): у выключенного канала сообщение НЕ
  // разбирается вовсе — ни детерминированным парсером, ни моделью. Раньше разбор шёл полностью, и
  // только каждое действие получало skip_reason='copy_disabled' — то есть выключенный тумблер
  // исправно тратил деньги на AI.
  it('enabled=false -> сообщение skipped/copy_disabled БЕЗ разбора: ни действий, ни разбора, ни AI', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'CCCUSDT', enabled: false })
    const text = '#CCC/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const row = await db.selectFrom('messages').selectAll().where('id', '=', message.id).executeTakeFirstOrThrow()
    expect(row.status).toBe('skipped')
    expect(row.status_reason).toBe('copy_disabled')

    const actions = await db.selectFrom('actions').selectAll().where('channel_id', '=', channelId).execute()
    expect(actions).toHaveLength(0)
    // Разбор не запускался — значит и повода звать модель не возникало.
    const parses = await db.selectFrom('parse_results').selectAll().where('message_id', '=', message.id).execute()
    expect(parses).toHaveLength(0)
    // Событие опубликовано: иначе в UI навсегда остался бы лоадер «Разбираем сообщение…».
    const events = await db.selectFrom('domain_events').selectAll().where('aggregate_id', '=', message.id).execute()
    expect(events.map((e) => e.type)).toContain('message.processed')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
    const positions = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).execute()
    expect(positions).toHaveLength(0)
    const ownership = await db.selectFrom('symbol_ownership').selectAll().where('channel_id', '=', channelId).execute()
    expect(ownership).toHaveLength(0) // символ не захвачен вовсе
  })

  it('enabled=true -> исполняется как раньше (без регрессии)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'DDDUSDT', enabled: true })
    const text = '#DDD/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders.length).toBeGreaterThan(0)
  })
})

describe('pipeline — TP-лесенка без нулевых долей (Minor #4)', () => {
  it('total=2, qtyStep=1, 3 цели -> НИ ОДНОГО tp-ордера с qty=0, весь объём в последней цели', async () => {
    const channelId = nextChannelId++
    // Плечо зажато в 1, поэтому позиция равна марже: trade_size=100 -> notional=100, entry=50 ->
    // qty=floor_to(1,2)=2. Тесту важен ровно qty=2: 2/3 < 1, и первые две доли splitQtyEvenly
    // обнулились бы без фильтра buildTpTargets.
    await seedChannel({ channelId, symbol: 'EEEUSDT', tradeSize: '100', qtyStep: '1', maxLeverage: '1' })
    const text = '#EEE/USDT 📈LONG\n\nДиапазон входа: 50 - 50$\nTP: 60$ - 65$ - 70$\nSL: 45$'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const tpOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('purpose', '=', 'tp')
      .execute()

    expect(tpOrders.every((o) => o.qty !== '0')).toBe(true)
    const totalTpQty = tpOrders.reduce((sum, o) => sum + Number(o.qty), 0)
    expect(totalTpQty).toBe(2) // весь qty ушёл в TP-ордера (одной или несколькими не-нулевыми целями)
  })
})

describe('pipeline — гейт staleness/slippage перед market-входом (Important I2)', () => {
  it('deps.getMarkPrice не подключён (dry_run, как в main.ts) -> гейт fail-open, вход как раньше', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'FFFUSDT' })
    // `deps` модуля — createExecutionPort('dry_run'), БЕЗ getMarkPrice (тот же контракт, что и
    // main.ts в dry_run) — гейт из pipeline.ts::handleEntrySignal не должен даже попытаться его
    // вызвать (сети попросту нет).
    const text = '#FFF/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
  })

  it('mark 6% выше сигнальной цены (100 -> 106), порог 0.5% по умолчанию -> skip price_slippage, 0 ордеров', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'GGGUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: async () => '106',
    }
    const text = '#GGG/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('price_slippage')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
  })

  it('mark 0.2% выше сигнальной цены (100 -> 100.2), в пределах порога 0.5% -> входит как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'HHHUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: async () => '100.2',
    }
    const text = '#HHH/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
  })

  it('кастомный порог maxEntrySlippagePct — 6% отклонение проходит, если порог поднят до 10%', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'IIIUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: async () => '106',
      maxEntrySlippagePct: '10',
    }
    const text = '#III/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
  })

  it('getMarkPrice возвращает null (сбой похода за ценой/тикер недоступен) -> гейт fail-CLOSED, skip mark_price_unavailable', async () => {
    // Фикс p3-slippage-fix (Important, найден e2e): раньше null тихо пропускал проверку
    // отклонения (fail-open) — торговая система входила вслепую по протухшему сигналу, если
    // сам поход за ценой сломался. Теперь null -> skip, а не молчаливый вход.
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'JJJUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: async () => null,
    }
    const text = '#JJJ/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
  })
})

describe('pipeline — createMarkPriceGetter(main.ts) + гейт I2, сквозь мок публичного тикера (фикс p3-slippage-fix)', () => {
  /** Мок rest-клиента с ЕДИНСТВЕННЫМ методом, нужным createMarkPriceGetter — getTicker. Тот же
   *  приём, что и createMockRest() в main-live.test.ts (мок узкого контракта, не всего BybitRestClient). */
  function mockRest(impl: MarkPriceRestClient['getTicker']): MarkPriceRestClient {
    return { getTicker: impl }
  }

  it('getTicker -> markPrice=106 при сигнале entry=100 (6% отклонение) -> skip price_slippage', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'KKKUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '106', lastPrice: '106' }))),
    }
    const text = '#KKK/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('price_slippage')
  })

  it('getTicker -> markPrice=100.2 (0.2% отклонение, в пределах порога 0.5%) -> входит как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LLLUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '100.2', lastPrice: '100.2' }))),
    }
    const text = '#LLL/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
  })

  it('getTicker бросает (сеть/биржа недоступна) -> createMarkPriceGetter -> null -> skip mark_price_unavailable (fail-CLOSED)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'MMMUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: createMarkPriceGetter(
        mockRest(async () => {
          throw new Error('Bybit сеть (/v5/market/tickers): connection reset')
        }),
      ),
    }
    const text = '#MMM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')
  })

  it('getTicker -> markPrice/lastPrice оба пусты (тикер вернул пустые строки) -> null -> skip mark_price_unavailable', async () => {
    // Защита от "тикер ответил, но без цены" (напр. delisted/приостановленный символ) — та же
    // логика fail-closed, что и для полного сбоя похода за ценой.
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'NNNUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '', lastPrice: '' }))),
    }
    const text = '#NNN/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')
  })

  it('getTicker -> markPrice пуст, но lastPrice непуст -> используется lastPrice как fallback', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'OOOUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      aiEnabled: false,
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '', lastPrice: '100.1' }))),
    }
    const text = '#OOO/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed') // 0.1% отклонение, в пределах порога 0.5%
  })
})

// Решение заказчика: после ЛЮБОГО ручного вмешательства оператора на бирже (закрытие/фиксация/сдвиг
// стопа руками) воля оператора главнее сигнала канала — канал больше не двигает защиту этой сделки.
// Флаг ставят догон истории и WS-атрибуция (см. sync/attribute.ts): исполнение мимо наших ордеров.
describe('pipeline — зеркало позиции после НАШЕГО полного закрытия', () => {
  it('close_remainder зануляет positions.size сразу, не дожидаясь пуша биржи', async () => {
    // Живой e2e: финальный пуш `position size=0` иногда до зеркала не доходит, и строка остаётся
    // с размером до закрытия — оператор видит фантомную позицию, а следующая дельта канала
    // пытается управлять несуществующей сделкой. В момент close_remainder правда известна нам
    // детерминированно: reduce-only market ушёл на ВЕСЬ остаток. Порт здесь ЗАПИСЫВАЮЩИЙ (мок
    // live-пути): сам он в `positions` ничего не пишет — как и BybitAdapter в проде.
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    const entry = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, entry), localDeps)
    // Живой путь зеркала — приватный WS; здесь его роль играет прямая вставка строки позиции.
    await db
      .insertInto('positions')
      .values({
        channel_id: channelId,
        symbol: 'ATOMUSDT',
        trade_id: (await db.selectFrom('trades').select('id').where('channel_id', '=', channelId).executeTakeFirstOrThrow()).id,
        side: 'long',
        size: '1',
        avg_price: '100',
      })
      .onConflict((oc) => oc.columns(['channel_id', 'symbol']).doUpdateSet({ size: '1', side: 'long', avg_price: '100' }))
      .execute()

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM закрываю позицию полностью'), localDeps)

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('symbol', '=', 'ATOMUSDT')
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('0.0000000000')
    // И висящие reduceOnly-остатки символа сняты той же уборкой (R8): раньше это делал только
    // обработчик flat-пуша приватного WS, а обнулив зеркало сами, мы лишили его атрибуции.
    expect(calls).toContain('cancelAllForSymbol:ATOMUSDT')
  })
})

describe('pipeline — manual_override: ручное управление оператора главнее канала', () => {
  it('sl_breakeven от канала пропускается, если сделка под ручным управлением', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    const entry = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, entry), localDeps)

    // Оператор вмешался руками на бирже — реконсиляция пометила сделку.
    await db.updateTable('trades').set({ manual_override: true }).where('channel_id', '=', channelId).execute()
    calls.length = 0

    // Канал просит перенести стоп в безубыток — но решение оператора важнее.
    await processMessage(db, await insertMessage(channelId, 2, '#ATOM - стоп перевел в б/у'), localDeps)

    const action = await actionFor(channelId, 2)
    expect(action.skip_reason).toBe('manual_override')
    expect(calls).toEqual([]) // ни одного похода на биржу — стоп оператора не тронут
  })

  it('close_remainder исполняется ДАЖЕ при manual_override — блокировать выход из позиции опасно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    const entry = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, entry), localDeps)

    await db.updateTable('trades').set({ manual_override: true }).where('channel_id', '=', channelId).execute()
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM - закрываю позицию по текущим'), localDeps)

    const action = await actionFor(channelId, 2)
    expect(action.status).toBe('executed')
    expect(calls).toContain('closePosition')
  })
})

// Свободный текст «Long BTC, с текущих» — самый частый способ дать сигнал. До этого он уходил в
// skip('not_implemented_phase1'): движок умел исполнять ТОЛЬКО структурный сигнал со стопом и
// диапазоном входа, поэтому канал свободного текста не торговал вообще ничем.
//
// Ключевой денежный инвариант этих входов: стопа в сигнале нет, а войти на плече без стопа — это
// ликвидация. Поэтому на позицию атомарно вешается ЗАЩИТНЫЙ стоп, выведенный из плеча канала.
describe('pipeline — вход по рынку и лимиткой (свободный текст)', () => {
  /** Живой mark для market_entry: цены в таком сигнале нет вовсе, она берётся с рынка. */
  const markAt = (price: string) => async () => price

  it('«Long BTC / Long SOL / С текущих» -> ДВА рыночных входа, оба с защитным стопом', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'BTCUSDT', adapterId: 'ch2-freeform', maxLeverage: '10', defaultLeverage: '10' })
    await db
      .insertInto('instruments')
      .values({
        symbol: 'SOLUSDT', network: 'testnet', base_coin: 'SOL', status: 'Trading',
        qty_step: '0.1', min_qty: '0.1', tick_size: '0.01', min_notional: '5',
        max_leverage: '50', leverage_step: '0.01', mmr: '0.005', refreshed_at: new Date(),
      })
      .execute()

    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = {
      executionPort: port,
      network: 'testnet',
      equity: '10000',
      getMarkPrice: markAt('100'), aiEnabled: false }

    const message = await insertMessage(channelId, 1, 'Long BTC\nLong SOL\nС текущих')
    await processMessage(db, message, localDeps)

    // Раньше здесь было два Skipped. Теперь — два реальных входа.
    const actions = await db.selectFrom('actions').selectAll().where('channel_id', '=', channelId).orderBy('action_index').execute()
    expect(actions).toHaveLength(2)
    expect(actions.map((a) => a.status)).toEqual(['executed', 'executed'])
    expect(actions.map((a) => a.symbol).sort()).toEqual(['BTCUSDT', 'SOLUSDT'])

    // Оба ордера — рыночные и СО СТОПОМ (позиция не висит без защиты ни секунды).
    expect(calls).toEqual(['placeEntry:stopLoss=91', 'placeEntry:stopLoss=91'])

    // Защитный стоп при плече 10x = 9% от входа: d = 1/10 − mmr(0.005) − буфер(0.005).
    const slOrders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'sl').execute()
    expect(slOrders).toHaveLength(2)
    for (const o of slOrders) expect(new Decimal(o.price!).toString()).toBe('91')

    const entries = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'entry').execute()
    for (const o of entries) expect(o.order_type).toBe('market')
  })

  it('«вход с текущий BTC long, риск 2%» -> размер из trade_size, риск БЕЗ стопа игнорируется', async () => {
    const channelId = nextChannelId++
    await seedChannel({
      channelId, symbol: 'BTCUSDT', adapterId: 'ch2-freeform',
      tradeSize: '150', maxLeverage: '10', defaultLeverage: '10',
    })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '10000',
      getMarkPrice: markAt('100'), aiEnabled: false }

    const message = await insertMessage(channelId, 1, 'BTC long с текущих')
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    // Стопа в сигнале нет → риск-формула неприменима (её знаменатель — стоп-дистанция). Размер
    // берётся из trade_size, а это МАРЖА: 150 маржи × плечо 10 = позиция 1500, при цене 100 это
    // qty=15. Из депозита при этом уходит ровно 150 — та цифра, что стоит в настройке канала.
    const entry = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'entry').executeTakeFirstOrThrow()
    expect(new Decimal(entry.qty!).toString()).toBe('15')
  })

  it('лимитный вход «зайду от 76.3» -> ордер limit по названной цене, гейт слиппеджа НЕ применяется', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'SOLUSDT', adapterId: 'ch2-freeform', maxLeverage: '10', defaultLeverage: '10' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = {
      executionPort: port,
      network: 'testnet',
      equity: '10000',
      // Рынок далеко от цены лимитки — для market-входа это был бы price_slippage. Лимитка по
      // определению стоит вне рынка, поэтому гейт к ней неприменим (иначе не сработал бы никогда).
      getMarkPrice: markAt('100'), aiEnabled: false }

    const message = await insertMessage(channelId, 1, 'Limit long SOL 76.3')
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
    expect(action.skip_reason).toBeNull()

    const entry = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'entry').executeTakeFirstOrThrow()
    expect(entry.order_type).toBe('limit')
    expect(new Decimal(entry.price!).toString()).toBe('76.3')
    expect(calls[0]).toContain('placeEntry:stopLoss=') // и лимитка тоже уходит на биржу со стопом
  })

  it('нет живой цены рынка -> вход по рынку НЕ открывается (fail-closed, не входим вслепую)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'BTCUSDT', adapterId: 'ch2-freeform' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '10000',
      getMarkPrice: async () => null, // сбой похода за ценой
      aiEnabled: false,
    }

    const message = await insertMessage(channelId, 1, 'BTC long с текущих')
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')
  })

})

// Живой инцидент: «фиксирую половину BTC, стоп на твх» на позиции, ушедшей в минус. Безубыток
// (= цена входа) оказался ВЫШЕ рынка — для лонга это невозможный стоп, Bybit отверг его (retCode
// 10001), исключение откатило транзакцию, сообщение навсегда осталось 'received' и переигрывалось
// каждые 5 секунд (108 раз), а в UI вечно крутился лоадер «Разбираем сообщение…».
describe('pipeline — стоп по ту сторону рынка не отправляется на биржу', () => {
  async function openPosition(channelId: number, symbol: string, entry: string, deps: PipelineDeps) {
    const text = `#${symbol.replace('USDT', '')}/USDT 📈LONG\n\nДиапазон входа: ${entry} - ${entry}$\nSL: ${Number(entry) * 0.9}$\n\nРиск: 1%`
    await processMessage(db, await insertMessage(channelId, 1, text), deps)
  }

  it('стоп в безубыток, когда позиция в минусе -> skip sl_beyond_market (а не падение транзакции)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })

    // Вход по 100, рынок ушёл на 95 — позиция в убытке.
    const { port, calls } = createRecordingExecutionPort()
    let mark = '100'
    const localDeps: PipelineDeps = {
      executionPort: port,
      network: 'testnet',
      equity: '10000',
      getMarkPrice: async () => mark, aiEnabled: false }
    await openPosition(channelId, 'ATOMUSDT', '100', localDeps)
    mark = '95'
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM - стоп перевел в б/у'), localDeps)

    const action = await actionFor(channelId, 2)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('sl_beyond_market')
    expect(calls).toEqual([]) // на биржу ничего не ушло — она бы это отвергла

    // Сообщение доведено до терминального статуса, а не осталось на вечный реплей.
    const message = await db.selectFrom('messages').selectAll().where('channel_id', '=', channelId).where('tg_message_id', '=', 2).executeTakeFirstOrThrow()
    expect(message.status).not.toBe('received')
  })

  it('стоп в безубыток, когда позиция в плюсе -> исполняется как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })

    const { port, calls } = createRecordingExecutionPort()
    let mark = '100'
    const localDeps: PipelineDeps = {
      executionPort: port,
      network: 'testnet',
      equity: '10000',
      getMarkPrice: async () => mark, aiEnabled: false }
    await openPosition(channelId, 'ATOMUSDT', '100', localDeps)
    mark = '110' // позиция в прибыли — безубыток НИЖЕ рынка, стоп корректен
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM - стоп перевел в б/у'), localDeps)

    const action = await actionFor(channelId, 2)
    expect(action.status).toBe('executed')
    expect(calls).toContain('setStopLoss')
  })
})

// Живой инцидент: «фиксирую половину BTC, стоп на твх» — бот перенёс стоп, но НИЧЕГО не зафиксировал.
// partial_close лежал в одной ветке с событиями tp_hit/sl_hit и был no-op: прямое указание автора
// («я сокращаю риск») игнорировалось, бот держал полный объём.
describe('pipeline — «фиксирую половину» реально закрывает часть позиции', () => {
  async function openPosition(channelId: number, deps: PipelineDeps) {
    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, text), deps)
  }

  it('«фиксирую» -> closePosition на ПОЛОВИНУ объёма, сделка становится partially_closed', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    // mark = цена входа: иначе гейт слиппеджа (0.5%) не даст открыть позицию.
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '10000', getMarkPrice: async () => '100' , aiEnabled: false }

    await openPosition(channelId, localDeps)
    const before = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).executeTakeFirstOrThrow()
    const fullSize = new Decimal(before.size)
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM фиксирую половину'), localDeps)

    const action = await actionFor(channelId, 2)
    expect(action.status).toBe('executed')
    expect(calls).toContain('closePosition') // раньше здесь не было НИ ОДНОГО вызова

    // Закрыта ровно половина, а не весь объём.
    const closeOrder = await db
      .selectFrom('orders')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('purpose', '=', 'close')
      .executeTakeFirstOrThrow()
    expect(new Decimal(closeOrder.qty!).toString()).toBe(fullSize.div(2).toString())

    const trade = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('partially_closed') // статус до этого не писал НИКТО
  })

  // ⚠️ Денежная граница: «первая цель взята» — это СОБЫТИЕ (у автора сработал TP). У нас на бирже
  // стоит СВОЙ reduce-only TP-ордер, он исполнится сам. Закрыть ещё и вручную = закрыть ВДВОЕ больше.
  it('«первая цель есть» -> НИЧЕГО не закрываем вручную (наш TP-ордер сработает сам)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '10000', getMarkPrice: async () => '100' , aiEnabled: false }

    await openPosition(channelId, localDeps)
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM первая цель есть'), localDeps)

    expect(calls).not.toContain('closePosition') // двойного закрытия быть не должно

    const trade = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open') // позиция не тронута
  })
})

// Три денежных дефекта, найденных адверсариальным разбором СОБСТВЕННОЙ реализации partial_close.
// Каждый из них проявился бы только в live и стоил бы денег.
describe('pipeline — фиксация части: остаток, ключи ордеров, двойное закрытие', () => {
  async function openWithTp(channelId: number, deps: PipelineDeps) {
    // Вход с TP-лесенкой — чтобы на бирже реально стояли reduce-only TP-ордера.
    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nTP: 110$ - 120$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, text), deps)
  }

  // ДЕФЕКТ 1: стоп считался от positions.size (зеркало биржи), а оно обновляется только ПОЗЖЕ, по
  // WS-пушу. После фиксации половины trading-stop (tpslMode='Full', slSize=qty) встал бы на ВДВОЕ
  // больший объём, чем реально остался.
  it('«фиксирую половину, стоп в б/у» -> стоп ставится на ОСТАТОК, а не на полный объём', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const inner = new DryRunAdapter()
    const closeQtys: string[] = []
    const slQtys: string[] = []
    const port: ExecutionPort = {
      cancelAllForSymbol: (symbol) => inner.cancelAllForSymbol(symbol),
      placeEntry: (tx, o) => inner.placeEntry(tx, o),
      placeTpLadder: (tx, p) => inner.placeTpLadder(tx, p),
      setStopLoss: (tx, p) => {
        slQtys.push(p.qty)
        return inner.setStopLoss(tx, p)
      },
      closePosition: (tx, p) => {
        closeQtys.push(p.qty)
        return inner.closePosition(tx, p)
      },
      cancelOrder: (tx, p) => inner.cancelOrder(tx, p),
    }
    // Цена входа = mark (иначе гейт слиппеджа не даст войти), затем рынок уходит в плюс — только
    // тогда безубыток вообще достижим (стоп обязан быть НИЖЕ рынка для лонга).
    let mark = '100'
    const deps2: PipelineDeps = { executionPort: port, network: 'testnet', equity: '10000', getMarkPrice: async () => mark , aiEnabled: false }

    const entryText = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, entryText), deps2)
    const pos = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).executeTakeFirstOrThrow()
    const full = new Decimal(pos.size)
    mark = '110'

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM фиксирую половину, стоп перевел в б/у'), deps2)

    expect(closeQtys).toHaveLength(1)
    expect(new Decimal(closeQtys[0]!).toString()).toBe(full.div(2).toString())
    // Стоп — на ОСТАТОК (половина), а не на весь исходный объём.
    expect(new Decimal(slQtys[slQtys.length - 1]!).toString()).toBe(full.div(2).toString())
  })

  // ДЕФЕКТ 2: два закрывающих ордера в одном сообщении получали ОДИН orderLinkId → Bybit отвергает
  // дубликат → откат транзакции → сообщение переигрывается вечно (паттерн инцидента со 108 повторами).
  it('два закрытия в одном сообщении -> РАЗНЫЕ orderLinkId (иначе биржа отвергнет дубликат)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const deps2: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '10000',
      getMarkPrice: async () => '100', aiEnabled: false }

    const entryText = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    await processMessage(db, await insertMessage(channelId, 1, entryText), deps2)

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM фиксирую половину, закрываю остаток'), deps2)

    const closeOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('purpose', '=', 'close')
      .execute()
    const linkIds = closeOrders.map((o) => o.order_link_id)
    expect(new Set(linkIds).size).toBe(linkIds.length) // все ключи уникальны
  })

  // ДЕФЕКТ 3: «первая цель взята, зафиксировал 50%» — это ОПИСАНИЕ одного закрытия, а не две команды.
  // Наш TP-ордер отработает сам; домаркетить ещё 50% = закрыть вдвое больше.
  it('«первая цель, зафиксировал 50%» при ЖИВОМ TP-ордере -> фиксация подавлена (без двойного закрытия)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const deps2: PipelineDeps = { executionPort: port, network: 'testnet', equity: '10000', getMarkPrice: async () => '100' , aiEnabled: false }

    await openWithTp(channelId, deps2)
    calls.length = 0

    await processMessage(db, await insertMessage(channelId, 2, '#ATOM первая цель есть, зафиксировал 50%'), deps2)

    expect(calls).not.toContain('closePosition') // TP-ордер закроет объём сам
  })
})

// Водяной знак истории канала (миграция 008). Живой инцидент прода 25.07.2026: новый сервер,
// каналы засидились с курсором 0, бэкфилл вытянул всю историю (~3100 сообщений), движок принял её
// за свежую — 2268 вызовов AI на $22.73, а сообщение от 30 декабря 2025 открыло РЕАЛЬНУЮ позицию
// на mainnet. Гейт обязан стоять ДО разбора: ни парсера, ни модели, ни ордеров.
describe('pipeline — история канала не разбирается (process_from_message_id)', () => {
  it('сообщение НЕ новее водяного знака -> archived, ни одного вызова биржи и разбора', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT', processFromMessageId: 500 })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    // Полноценный торговый сигнал: без гейта он бы исполнился (см. тесты выше с этим же текстом).
    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 500, text)
    await processMessage(db, message, localDeps)

    const row = await db.selectFrom('messages').selectAll().where('id', '=', message.id).executeTakeFirstOrThrow()
    expect(row.status).toBe('archived')
    expect(row.status_reason).toBe('historical_backlog')

    expect(calls).toEqual([])
    const actions = await db.selectFrom('actions').selectAll().where('channel_id', '=', channelId).execute()
    expect(actions).toHaveLength(0)
    // Разбор вообще не запускался — значит нет и строки parse_results (а с ней и повода звать AI).
    const parses = await db.selectFrom('parse_results').selectAll().where('message_id', '=', message.id).execute()
    expect(parses).toHaveLength(0)
    // Событие опубликовано: иначе в UI навсегда остался бы лоадер «Разбираем сообщение…».
    const events = await db.selectFrom('domain_events').selectAll().where('aggregate_id', '=', message.id).execute()
    expect(events.map((e) => e.type)).toContain('message.processed')
  })

  it('сообщение СТРОГО новее водяного знака -> обрабатывается как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT', processFromMessageId: 500 })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 501, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 501)
    expect(action.status).toBe('executed')
    expect(calls).toEqual(['placeEntry:stopLoss=90'])
  })

  it('водяной знак 0 (канал без истории) -> обрабатываются все сообщения, включая самое первое', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000', aiEnabled: false }

    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
  })
})
