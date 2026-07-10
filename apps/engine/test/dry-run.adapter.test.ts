import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side } from 'shared/domain.js'
import { acquireSymbol, addLeg, openTrade } from '../src/state/trades.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { createExecutionPort } from '../src/execution/port.js'

// DryRunAdapter (задача 6, design spec §14): исполнение без биржи. Каждый метод пишет
// orders/executions/positions ТЕ ЖЕ строки, что писал бы live-адаптер, но НИ ОДНОГО обращения
// к Bybit — проверяем это косвенно (нет сетевого клиента вообще в зависимостях адаптера).

let db: Kysely<DB>
const adapter = new DryRunAdapter()

// channels.id=1/ord=1 — единственный канал, используемый во всех сценариях (channelOrd
// участвует в orderLinkId, см. order-link-id.ts).
const CHANNEL_ID = 1
const CHANNEL_ORD = 1

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  // Идемпотентные прогоны против одной и той же copytrade_test (как trades.test.ts).
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1')
  `.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

let tgMessageSeq = 100000

/** Сообщение-источник действия — FK-якорь для actions.message_id (схема требует NOT NULL). */
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

/** Действие-источник ордера — FK-якорь для orders.action_id (схема требует NOT NULL). */
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

/**
 * Полный контекст одного сценария: message → action → trade → entry-лега. Ровно то, что в
 * реальном пайплайне готовит парсер/оркестратор ДО вызова ExecutionPort (задача 6 не отвечает
 * за их создание, только переиспользует готовые id).
 */
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

describe('DryRunAdapter.placeEntry', () => {
  it('market -> orders(filled) + executions + positions одной строкой', async () => {
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
      qty: '100',
      price: '50000',
      leverage: '10',
    })

    // формат ключа — пример из брифа order-link-id.ts (D<ord:2>-<tgMessageId>-<actionIndex:2>-<purpose><legIndex>)
    expect(result.orderLinkId).toBe(`D01-${ctx.tgMessageId}-00-E0`)

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
    expect(order.purpose).toBe('entry')
    expect(order.reduce_only).toBe(false)
    expect(order.qty).toBe('100.0000000000')
    expect(order.price).toBe('50000.0000000000')

    const exec = await db
      .selectFrom('executions')
      .selectAll()
      .where('order_id', '=', result.orderId)
      .executeTakeFirstOrThrow()
    expect(exec.exec_qty).toBe('100.0000000000')
    expect(exec.exec_price).toBe('50000.0000000000')
    expect(exec.bybit_exec_id).toBe(`sim-${result.orderLinkId}`)

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'BTCUSDT')
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('100.0000000000')
    expect(position.avg_price).toBe('50000.0000000000')
    // task-6-brief.md: mark_price = avg_price "на момент открытия" (реальный фид — задача 9)
    expect(position.mark_price).toBe('50000.0000000000')
    expect(position.side).toBe('long')
  })

  it('limit -> orders(submitted), без executions/positions (филла в Ф1 не будет)', async () => {
    const ctx = await setupTradeContext('SOLUSDT', 'short')

    const result = await adapter.placeEntry(db, {
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
      qty: '50',
      price: '150',
      leverage: '3',
    })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('submitted')

    const execCount = await db
      .selectFrom('executions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('order_id', '=', result.orderId)
      .executeTakeFirstOrThrow()
    expect(Number(execCount.n)).toBe(0)

    const posCount = await db
      .selectFrom('positions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'SOLUSDT')
      .executeTakeFirstOrThrow()
    expect(Number(posCount.n)).toBe(0)
  })

  it('повторный вызов с тем же orderLinkId — идемпотентно: не плодит второй ордер и не удваивает позицию', async () => {
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
    }

    const first = await adapter.placeEntry(db, params)
    const second = await adapter.placeEntry(db, params) // ретрай/реконнект того же сообщения

    expect(second.orderId).toBe(first.orderId)
    expect(second.orderLinkId).toBe(first.orderLinkId)

    const orderCount = await db
      .selectFrom('orders')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('order_link_id', '=', first.orderLinkId)
      .executeTakeFirstOrThrow()
    expect(Number(orderCount.n)).toBe(1)

    const execCount = await db
      .selectFrom('executions')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('order_id', '=', first.orderId)
      .executeTakeFirstOrThrow()
    expect(Number(execCount.n)).toBe(1) // не удвоился

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'ETHUSDT')
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('10.0000000000') // не удвоилось (было бы 20 без идемпотентности)
  })

  it('"add" (доливка) — второй entry-филл по тому же символу суммирует size и пересчитывает средневзвешенную avg_price', async () => {
    const ctx = await setupTradeContext('MATICUSDT', 'long')
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'MATICUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '100',
      price: '10',
      leverage: '5',
    })

    // Доливка — новая лега (leg_index=1, kind='add'), тот же tradeId/symbol/channel.
    // purpose='add' даёт другой orderLinkId (буква A вместо E), даже с тем же tgMessageId/actionIndex.
    const addLegRow = await addLeg(db, { tradeId: ctx.tradeId, legIndex: 1, kind: 'add', requestedQty: '50' })
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: addLegRow.legId,
      symbol: 'MATICUSDT',
      side: 'long',
      purpose: 'add',
      orderType: 'market',
      qty: '50',
      price: '20',
      leverage: '5',
    })

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'MATICUSDT')
      .executeTakeFirstOrThrow()
    // size = 100+50 = 150; avg_price = (100*10 + 50*20) / 150 = 2000/150 = 13.3333333333
    expect(position.size).toBe('150.0000000000')
    expect(position.avg_price).toBe('13.3333333333')
    expect(position.mark_price).toBe('20.0000000000') // mark = цена ПОСЛЕДНЕГО филла
  })
})

describe('DryRunAdapter.placeTpLadder', () => {
  it('3 цели -> 3 reduceOnly-ордера с разными tp_index и разными order_link_id', async () => {
    const ctx = await setupTradeContext('XRPUSDT', 'long')
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'XRPUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '300',
      price: '2',
      leverage: '5',
    })

    const result = await adapter.placeTpLadder(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 1, // отдельное действие в том же сообщении (или management-сообщение)
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'XRPUSDT',
      side: 'long',
      tps: [
        { price: '2.2', qty: '100', index: 0 },
        { price: '2.4', qty: '100', index: 1 },
        { price: '2.6', qty: '100', index: 2 },
      ],
    })

    expect(result.orderIds).toHaveLength(3)
    expect(new Set(result.orderIds).size).toBe(3) // все id разные

    const orders = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', 'in', result.orderIds)
      .orderBy('tp_index', 'asc')
      .execute()

    expect(orders.map((o) => o.tp_index)).toEqual([0, 1, 2])
    expect(orders.every((o) => o.purpose === 'tp')).toBe(true)
    expect(orders.every((o) => o.reduce_only)).toBe(true)
    expect(orders.every((o) => o.status === 'submitted')).toBe(true)
    expect(new Set(orders.map((o) => o.order_link_id)).size).toBe(3)
  })
})

describe('DryRunAdapter.setStopLoss', () => {
  it('создаёт order(purpose=sl, reduceOnly) и обновляет positions.stop_loss', async () => {
    const ctx = await setupTradeContext('ADAUSDT', 'long')
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'ADAUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '1000',
      price: '0.5',
      leverage: '5',
    })

    const result = await adapter.setStopLoss(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'ADAUSDT',
      side: 'long',
      price: '0.45',
      qty: '1000',
    })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.purpose).toBe('sl')
    expect(order.reduce_only).toBe(true)
    expect(order.status).toBe('submitted')

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'ADAUSDT')
      .executeTakeFirstOrThrow()
    expect(position.stop_loss).toBe('0.4500000000')
  })
})

describe('DryRunAdapter.closePosition', () => {
  it('на весь size обнуляет positions.size и освобождает symbol_ownership', async () => {
    const ctx = await setupTradeContext('DOTUSDT', 'long')
    await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: 'DOTUSDT', tradeId: ctx.tradeId })
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'DOTUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '200',
      price: '7',
      leverage: '5',
    })

    const result = await adapter.closePosition(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 2,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'DOTUSDT',
      side: 'long',
      qty: '200',
    })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', result.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled')
    expect(order.purpose).toBe('close')
    expect(order.reduce_only).toBe(true)

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'DOTUSDT')
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('0.0000000000')

    const ownership = await db
      .selectFrom('symbol_ownership')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'DOTUSDT')
      .where('trade_id', '=', ctx.tradeId)
      .executeTakeFirstOrThrow()
    expect(ownership.released_at).not.toBeNull()

    // символ снова свободен — другая сделка того же канала может его захватить
    const otherTrade = await openTrade(db, { channelId: CHANNEL_ID, symbol: 'DOTUSDT', side: 'short' })
    expect(await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: 'DOTUSDT', tradeId: otherTrade.tradeId })).toBe(true)
  })

  it('частичное закрытие — уменьшает size, symbol_ownership НЕ освобождается', async () => {
    const ctx = await setupTradeContext('LTCUSDT', 'long')
    await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: 'LTCUSDT', tradeId: ctx.tradeId })
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'LTCUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '100',
      price: '80',
      leverage: '5',
    })

    await adapter.closePosition(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 3,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'LTCUSDT',
      side: 'long',
      qty: '40',
    })

    const position = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'LTCUSDT')
      .executeTakeFirstOrThrow()
    expect(position.size).toBe('60.0000000000')

    const ownership = await db
      .selectFrom('symbol_ownership')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', 'LTCUSDT')
      .where('trade_id', '=', ctx.tradeId)
      .executeTakeFirstOrThrow()
    expect(ownership.released_at).toBeNull() // позиция ещё не закрыта полностью
  })
})

describe('DryRunAdapter.cancelOrder', () => {
  it('помечает submitted-ордер cancelled', async () => {
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
      orderType: 'limit', // submitted, не filled — есть что отменять
      qty: '40',
      price: '12',
      leverage: '5',
    })

    await adapter.cancelOrder(db, { orderLinkId: entry.orderLinkId })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', entry.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('cancelled')
    expect(order.cancelled_at).not.toBeNull()
  })

  it('filled-ордер cancelOrder не трогает (не переводит обратно в cancelled)', async () => {
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
      orderType: 'market', // сразу filled
      qty: '20',
      price: '30',
      leverage: '5',
    })

    await adapter.cancelOrder(db, { orderLinkId: entry.orderLinkId })

    const order = await db.selectFrom('orders').selectAll().where('id', '=', entry.orderId).executeTakeFirstOrThrow()
    expect(order.status).toBe('filled') // не перезаписан в cancelled
    expect(order.cancelled_at).toBeNull()
  })
})

describe('createExecutionPort', () => {
  it("mode='dry_run' -> DryRunAdapter", () => {
    const port = createExecutionPort('dry_run')
    expect(port).toBeInstanceOf(DryRunAdapter)
  })

  it("mode='live' -> бросает (BybitAdapter — Ф3, ещё не реализован)", () => {
    expect(() => createExecutionPort('live')).toThrow()
  })
})
