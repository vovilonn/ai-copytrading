import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side } from 'shared/domain.js'
import type { BybitRestClient, CreateOrderParams, SetTradingStopParams } from '../src/bybit/rest-client.js'
import { addLeg, openTrade } from '../src/state/trades.js'
import { BybitAdapter, type BybitAdapterRestClient } from '../src/execution/bybit.adapter.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { createExecutionPort } from '../src/execution/port.js'

// BybitAdapter (Ф3, задача 2, design plan docs/superpowers/plans/2026-07-11-phase-3-live-testnet.md):
// ЮНИТ-тесты с МОКОМ BybitRestClient — реальный Bybit НЕ вызывается. Живые ордера — только
// e2e задачи 6 (BYBIT_LIVE_TESTS=1). Здесь проверяем: последовательность switchMode→setLeverage→
// createOrder, детерминированный orderLinkId с префиксом 'K', идемпотентность по 110072 (мок),
// направленное округление qty/price по instruments (qtyStep/tickSize), и фабрику createExecutionPort.

let db: Kysely<DB>

const CHANNEL_ID = 1
const CHANNEL_ORD = 1

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1')
  `.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

let tgMessageSeq = 200_000

/** Сообщение-источник действия — FK-якорь для actions.message_id. */
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

interface InstrumentOpts {
  symbol: string
  qtyStep?: string
  tickSize?: string
  leverageStep?: string
}

/** Инструмент нужен BybitAdapter'у для округления qty/price (getInstrument, ../src/instruments.ts). */
async function seedInstrument(opts: InstrumentOpts): Promise<void> {
  await db
    .insertInto('instruments')
    .values({
      symbol: opts.symbol,
      network: 'testnet',
      base_coin: opts.symbol.replace(/USDT$/, ''),
      status: 'Trading',
      qty_step: opts.qtyStep ?? '0.001',
      min_qty: opts.qtyStep ?? '0.001',
      tick_size: opts.tickSize ?? '0.1',
      min_notional: '5',
      max_leverage: '50',
      leverage_step: opts.leverageStep ?? '1',
      mmr: '0.005',
      refreshed_at: new Date(),
    })
    .onConflict((oc) => oc.columns(['symbol', 'network']).doNothing())
    .execute()
}

async function setupTradeContext(
  symbol: string,
  side: Side,
): Promise<{ tgMessageId: number; actionId: string; tradeId: string; legId: string }> {
  const { messageId, tgMessageId } = await seedMessage()
  const actionId = await seedAction({ messageId, symbol, side })
  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol, side })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '1' })
  return { tgMessageId, actionId, tradeId: trade.tradeId, legId: leg.legId }
}

/**
 * Мок BybitRestClient (никакой сети): createOrder симулирует реальное поведение биржи —
 * первый вызов с данным orderLinkId → успех с уникальным orderId; повторный вызов с ТЕМ ЖЕ
 * orderLinkId → 110072-идемпотентность (orderId='', idempotent:true), см. rest-client.ts.
 */
function createMockRest(): { rest: BybitAdapterRestClient; calls: string[] } {
  const calls: string[] = []
  const seenOrderLinkIds = new Set<string>()
  let orderSeq = 0

  const rest: BybitAdapterRestClient = {
    switchMode: vi.fn(async (symbol: string, mode: 0 | 3) => {
      calls.push(`switchMode:${symbol}:${mode}`)
      return { ok: true as const }
    }),
    setLeverage: vi.fn(async (symbol: string, leverage: string) => {
      calls.push(`setLeverage:${symbol}:${leverage}`)
      return { ok: true as const, idempotent: false }
    }),
    createOrder: vi.fn(async (params: CreateOrderParams) => {
      calls.push(`createOrder:${params.orderLinkId}`)
      if (seenOrderLinkIds.has(params.orderLinkId)) {
        return { orderId: '', orderLinkId: params.orderLinkId, ok: true as const, idempotent: true }
      }
      seenOrderLinkIds.add(params.orderLinkId)
      orderSeq += 1
      return { orderId: `bybit-order-${orderSeq}`, orderLinkId: params.orderLinkId, ok: true as const, idempotent: false }
    }),
    setTradingStop: vi.fn(async (_params: SetTradingStopParams) => {
      calls.push('setTradingStop')
      return { ok: true as const }
    }),
    cancelOrder: vi.fn(async (params: { symbol: string; orderLinkId: string }) => {
      calls.push(`cancelOrder:${params.orderLinkId}`)
      return { ok: true as const }
    }),
  }

  return { rest, calls }
}

describe('BybitAdapter.placeEntry', () => {
  it('market: switchMode(0) -> setLeverage -> createOrder, orderLinkId с префиксом K, bybit_order_id из ответа', async () => {
    await seedInstrument({ symbol: 'BTCUSDT', qtyStep: '0.001', tickSize: '0.1', leverageStep: '1' })
    const { rest, calls } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('BTCUSDT', 'long')

    const result = await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'BTCUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '0.12345', // округлится вниз до qtyStep=0.001 -> 0.123
      price: '50000.123', // market -> НЕ округляется (не идёт в API-параметр price)
      leverage: '10',
      liqPrice: '45250',
    })

    expect(result.orderLinkId).toBe(`K01-${ctx.tgMessageId}-00-E0`)
    // Порядок вызовов — строго switchMode -> setLeverage -> createOrder (research §1/§2/§8).
    expect(calls).toEqual(['switchMode:BTCUSDT:0', 'setLeverage:BTCUSDT:10', `createOrder:${result.orderLinkId}`])

    const createOrderCall = vi.mocked(rest.createOrder).mock.calls[0]?.[0]
    expect(createOrderCall).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'Buy', // long entry -> Buy
      orderType: 'Market',
      qty: '0.123',
      positionIdx: 0,
    })
    expect(createOrderCall).not.toHaveProperty('price') // market — цена не передаётся в API

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.bybit_order_id).toBe('bybit-order-1')
    expect(order.status).toBe('submitted') // не 'filled' — реальный филл подтверждает WS (задача 3), не createOrder
    expect(order.qty).toBe('0.1230000000')
    expect(order.reduce_only).toBe(false)

    // Сознательное отступление (см. bybit.adapter.ts, топ-комментарий): БЕЗ executions — createOrder
    // не даёт цену/qty реального филла, "угадывание" задвоило бы филл при приходе настоящего WS-события.
    const execCount = await db
      .selectFrom('executions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('order_id', '=', result.orderId)
      .executeTakeFirstOrThrow()
    expect(Number(execCount.n)).toBe(0)
  })

  it('limit: цена округляется НАПРАВЛЕННО к tickSize (short entry -> Sell -> ceil)', async () => {
    await seedInstrument({ symbol: 'SOLUSDT', qtyStep: '0.1', tickSize: '0.01', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('SOLUSDT', 'short')

    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'SOLUSDT',
      side: 'short',
      purpose: 'entry',
      orderType: 'limit',
      qty: '5',
      price: '150.123', // /0.01=15012.3 -> ceil (Sell) -> 15013 -> *0.01 = 150.13
      leverage: '3',
      liqPrice: '195',
    })

    const createOrderCall = vi.mocked(rest.createOrder).mock.calls[0]?.[0]
    expect(createOrderCall).toMatchObject({ side: 'Sell', orderType: 'Limit', price: '150.13' })
  })

  it('повтор с тем же orderLinkId (мок createOrder -> 110072/idempotent) — не второй ордер в БД', async () => {
    await seedInstrument({ symbol: 'ETHUSDT', qtyStep: '0.01', tickSize: '0.1', leverageStep: '1' })
    const { rest, calls } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('ETHUSDT', 'long')

    const params = {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'ETHUSDT',
      side: 'long' as const,
      purpose: 'entry' as const,
      orderType: 'market' as const,
      qty: '10',
      price: '3000',
      leverage: '5',
      liqPrice: '2410',
    }

    const first = await adapter.placeEntry(db, params)
    const second = await adapter.placeEntry(db, params) // ретрай/реконнект того же сообщения

    expect(second.orderId).toBe(first.orderId)
    expect(second.orderLinkId).toBe(first.orderLinkId)
    // switchMode/setLeverage/createOrder вызваны СНОВА (сеть идемпотентна сама по себе,
    // research §2/§8) — но локальная строка orders не задвоилась (ON CONFLICT DO NOTHING).
    expect(calls.filter((c) => c.startsWith('createOrder:')).length).toBe(2)

    const orderCount = await db
      .selectFrom('orders')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('order_link_id', '=', first.orderLinkId)
      .executeTakeFirstOrThrow()
    expect(Number(orderCount.n)).toBe(1)

    // bybit_order_id из ПЕРВОЙ успешной попытки не затёрт вторым (идемпотентным, orderId='') ответом.
    const order = await db.selectFrom('orders').selectAll().where('id', '=', first.orderId).executeTakeFirstOrThrow()
    expect(order.bybit_order_id).toBe('bybit-order-1')
  })
})

describe('BybitAdapter.placeTpLadder', () => {
  it('3 цели -> 3 createOrder reduceOnly с разными orderLinkId K...-T0/T1/T2, qty кратно qtyStep, сумма = размеру позиции', async () => {
    await seedInstrument({ symbol: 'XRPUSDT', qtyStep: '1', tickSize: '0.01', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('XRPUSDT', 'long')

    // total=300, поровну на 3 -> 100/100/100 (уже поделено вызывающей стороной, pipeline.ts,
    // адаптер лишь защитно floor'ит к qtyStep — здесь qtyStep=1, floor — no-op).
    const result = await adapter.placeTpLadder(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 1,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'XRPUSDT',
      side: 'long',
      tps: [
        { price: '2.2', qty: '100', index: 0 },
        { price: '2.4', qty: '100', index: 1 },
        { price: '2.6', qty: '99.6', index: 2 }, // последняя добивает остаток (99.6 -> floor к qtyStep=1 -> 99)
      ],
    })

    expect(result.orderIds).toHaveLength(3)
    expect(new Set(result.orderIds).size).toBe(3)

    const createOrderCalls = vi.mocked(rest.createOrder).mock.calls.map((c) => c[0])
    expect(createOrderCalls).toHaveLength(3)
    for (const [i, call] of createOrderCalls.entries()) {
      expect(call).toMatchObject({
        symbol: 'XRPUSDT',
        side: 'Sell', // long -> TP закрывается Sell
        orderType: 'Limit',
        reduceOnly: true,
        timeInForce: 'GTC',
        orderLinkId: `K01-${ctx.tgMessageId}-01-T${i}`,
      })
    }

    const orders = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', 'in', result.orderIds)
      .orderBy('tp_index', 'asc')
      .execute()

    expect(orders.map((o) => o.tp_index)).toEqual([0, 1, 2])
    expect(orders.every((o) => o.purpose === 'tp')).toBe(true)
    expect(orders.every((o) => o.reduce_only)).toBe(true)
    expect(orders.map((o) => o.qty)).toEqual(['100.0000000000', '100.0000000000', '99.0000000000'])
    expect(new Set(orders.map((o) => o.order_link_id)).size).toBe(3)
    expect(orders.every((o) => o.bybit_order_id !== null)).toBe(true)
  })
})

describe('BybitAdapter.setStopLoss', () => {
  it('setTradingStop(tpslMode=Full, slSize=qty), цена округлена к тику направленно (long -> Sell -> ceil)', async () => {
    await seedInstrument({ symbol: 'ADAUSDT', qtyStep: '1', tickSize: '0.01', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('ADAUSDT', 'long')

    const result = await adapter.setStopLoss(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'ADAUSDT',
      side: 'long',
      price: '0.451', // /0.01=45.1 -> ceil (Sell, closeSide лонга) -> 46 -> *0.01=0.46
      qty: '1000',
    })

    expect(rest.setTradingStop).toHaveBeenCalledWith({
      symbol: 'ADAUSDT',
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: '0.46',
      slSize: '1000',
    })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.purpose).toBe('sl')
    expect(order.reduce_only).toBe(true)
    expect(order.status).toBe('submitted')
    expect(order.bybit_order_id).toBeNull() // trading-stop — не ордер, orderId не существует
  })
})

describe('BybitAdapter.closePosition', () => {
  it('createOrder reduceOnly Market, orderLinkId K...-C0, qty округлён до qtyStep', async () => {
    await seedInstrument({ symbol: 'DOTUSDT', qtyStep: '0.1', tickSize: '0.001', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('DOTUSDT', 'long')

    const result = await adapter.closePosition(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 2,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'DOTUSDT',
      side: 'long',
      qty: '199.97', // floor к 0.1 -> 199.9
    })

    expect(rest.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'DOTUSDT',
        side: 'Sell',
        orderType: 'Market',
        qty: '199.9',
        reduceOnly: true,
        orderLinkId: `K01-${ctx.tgMessageId}-02-C0`,
      }),
    )

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.purpose).toBe('close')
    expect(order.order_type).toBe('market')
    expect(order.order_link_id).toBe(`K01-${ctx.tgMessageId}-02-C0`)
    expect(order.bybit_order_id).toBe('bybit-order-1')
  })
})

describe('BybitAdapter.cancelOrder', () => {
  it('submitted-ордер: зовёт rest.cancelOrder и помечает cancelled', async () => {
    await seedInstrument({ symbol: 'LINKUSDT', qtyStep: '0.1', tickSize: '0.01', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('LINKUSDT', 'long')

    const entry = await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'LINKUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'limit', // 'submitted', не 'filled' — есть что отменять
      qty: '4',
      price: '12',
      leverage: '5',
      liqPrice: '9.66',
    })

    await adapter.cancelOrder(db, { orderLinkId: entry.orderLinkId })

    expect(rest.cancelOrder).toHaveBeenCalledWith({ symbol: 'LINKUSDT', orderLinkId: entry.orderLinkId })
    const order = await db.selectFrom('orders').selectAll().where('id', '=', entry.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('cancelled')
    expect(order.cancelled_at).not.toBeNull()
  })

  it('уже filled-ордер: rest.cancelOrder НЕ вызывается, статус не трогается (терминальный)', async () => {
    await seedInstrument({ symbol: 'AVAXUSDT', qtyStep: '0.1', tickSize: '0.01', leverageStep: '1' })
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    const ctx = await setupTradeContext('AVAXUSDT', 'long')

    const entry = await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'AVAXUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '2',
      price: '30',
      leverage: '5',
      liqPrice: '24.15',
    })
    // placeEntry всегда пишет статус 'submitted' (не 'filled') — форсируем 'filled' вручную,
    // чтобы проверить именно терминальный гейт cancelOrder (реальный переход в 'filled' сделает
    // приватный WS-мост, задача 3, здесь не в фокусе).
    await db.updateTable('orders').set({ status: 'filled', filled_at: new Date() }).where('id', '=', entry.orderId).execute()

    await adapter.cancelOrder(db, { orderLinkId: entry.orderLinkId })

    expect(rest.cancelOrder).not.toHaveBeenCalled()
    const order = await db.selectFrom('orders').selectAll().where('id', '=', entry.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
  })

  it('несуществующий orderLinkId — no-op, не бросает', async () => {
    const { rest } = createMockRest()
    const adapter = new BybitAdapter(rest, 'testnet')
    await expect(adapter.cancelOrder(db, { orderLinkId: 'K99-000000-00-E0' })).resolves.toBeUndefined()
    expect(rest.cancelOrder).not.toHaveBeenCalled()
  })
})

describe('createExecutionPort', () => {
  it("mode='live' с deps -> BybitAdapter", () => {
    const { rest } = createMockRest()
    const port = createExecutionPort('live', { rest: rest as unknown as BybitRestClient, network: 'testnet' })
    expect(port).toBeInstanceOf(BybitAdapter)
  })

  it("mode='live' без deps -> бросает", () => {
    expect(() => createExecutionPort('live')).toThrow()
  })

  it("mode='dry_run' -> DryRunAdapter (не задет фабрикой live)", () => {
    const port = createExecutionPort('dry_run')
    expect(port).toBeInstanceOf(DryRunAdapter)
  })
})
