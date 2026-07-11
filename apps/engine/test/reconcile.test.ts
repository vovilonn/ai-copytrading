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
import { BybitRestClient, type Order, type Position } from '../src/bybit/rest-client.js'
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

// reconcileOnStart сканирует ВСЮ таблицу trades (не по одному каналу/символу, в отличие от
// большинства тестов engine) — полный TRUNCATE перед КАЖДЫМ тестом обязателен, иначе сделки
// одного сценария всплывали бы в шаге "закрыть по бирже" следующего сценария.
beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1')
  `.execute(db)
})

let tgMessageSeq = 400_000

async function seedMessage(): Promise<{ messageId: string; tgMessageId: number }> {
  const tgMessageId = tgMessageSeq++
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
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

async function seedAction(params: { messageId: string; symbol: string; side: Side }): Promise<string> {
  const row = await db
    .insertInto('actions')
    .values({
      message_id: params.messageId,
      channel_id: CHANNEL_ID,
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
}

/**
 * Готовит полный локальный след сделки через РЕАЛЬНЫЙ ExecutionPort.placeEntry (не руками) —
 * orderLinkId и его K/D-префикс должны быть настоящими, реконсиляция различает live/dry-run
 * именно по нему (см. topверху файла и reconcile.ts). После вызова порта pipeline.ts ВСЕГДА
 * обновляет trades (status/avg_entry/size/leverage, см. pipeline.ts::handleEntrySignal) — та же
 * последовательность воспроизведена здесь вручную (задача 4 не трогает pipeline.ts).
 */
async function seedTrade(opts: SeedTradeOpts): Promise<{ tradeId: string; humanRef: string; orderLinkId: string }> {
  const { messageId, tgMessageId } = await seedMessage()
  const actionId = await seedAction({ messageId, symbol: opts.symbol, side: opts.side })
  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol: opts.symbol, side: opts.side })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: opts.size ?? '1' })

  const entryParams = {
    channelId: CHANNEL_ID,
    channelOrd: CHANNEL_ORD,
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
    await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: opts.symbol, tradeId: trade.tradeId })
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

function makeRest(positions: Position[], openOrders: Order[] = []): ReconcileRestClient {
  return {
    getPositions: vi.fn(async () => positions),
    getOpenOrders: vi.fn(async () => openOrders),
  }
}

async function auditLogRows(): Promise<Array<{ action: string; entity_id: string | null }>> {
  const { rows } = await sql<{ action: string; entity_id: string | null }>`
    SELECT action, entity_id FROM audit_log WHERE actor = 'reconcileOnStart' ORDER BY id
  `.execute(db)
  return rows
}

describe('reconcileOnStart', () => {
  it('позиция на бирже без атрибуции в журнале -> flagged, канал не угадывается (audit_log)', async () => {
    const rest = makeRest([makePosition({ symbol: 'UNKNOWNUSDT', side: 'Buy', size: '10' })])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 1 })

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

    const rest = makeRest(
      [makePosition({ symbol: 'ATTRUSDT', side: 'Buy', size: '20', avgPrice: '150', leverage: '7' })],
      [makeOrder({ symbol: 'ATTRUSDT', orderLinkId: seeded.orderLinkId })],
    )

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 1, closed: 0, flagged: 0 })

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
    const live = await seedTrade({ symbol: 'CLOSEUSDT', side: 'long', live: true, status: 'open' })
    const dryRun = await seedTrade({ symbol: 'DRYUSDT', side: 'long', live: false, status: 'open' })

    const rest = makeRest([]) // на бирже вообще ничего не открыто

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 1, flagged: 0 })

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

    const rest = makeRest([
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
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0 })

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

  it('createdTime-защита: позиция биржи старше локального opened_at -> НЕ синкается, флагуется', async () => {
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

    const rest = makeRest([
      makePosition({
        symbol: 'OLDUSDT',
        side: 'Buy',
        size: '99',
        avgPrice: '999',
        // на 10 минут раньше нашего opened_at — "чужая" позиция (research §14), не наша
        createdTime: String(openedAt.getTime() - 10 * 60_000),
      }),
    ])

    const result = await reconcileOnStart(db, rest)
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 1 })

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', seeded.tradeId).executeTakeFirstOrThrow()
    expect(trade.status).toBe('open') // не закрыт — позиция формально существует на символе
    expect(new Decimal(trade.avg_entry!).toString()).toBe('50') // НЕ перезаписан "чужими" 999

    const audit = await auditLogRows()
    expect(audit.map((r) => r.action)).toEqual(['ambiguous_position'])
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
    expect(result).toEqual({ opened: 0, closed: 0, flagged: 0 })
  })
})
