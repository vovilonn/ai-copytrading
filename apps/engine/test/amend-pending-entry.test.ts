import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Kysely, sql } from 'kysely'
import { Decimal } from 'decimal.js'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import type { OrderStatus } from 'shared/domain.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { addLeg, openTrade } from '../src/state/trades.js'
import {
  amendPendingEntry,
  checkAmendGuard,
  findPendingEntry,
  stopLossForRisk,
  type AmendRestClient,
} from '../src/state/amend-pending-entry.js'

// Правка ещё не исполненного отложенного входа (`pnpm order:amend`). Живой повод: лимитка ETHUSDT
// была выставлена по старому смыслу trade_size, и её понадобилось довести до задуманного объёма,
// не разрывая связь со сделкой — руками на бирже это невозможно (отдельный ордер исполнится «мимо
// наших» и уведёт сделку в manual_override).

let db: Kysely<DB>
const CHANNEL_ID = 1
const LINK_ID = 'K01-777-00-E0'

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, 1, 'ch1', 'channel', 'ch1')`.execute(db)
})

/** Сделка с отложенным входом: лимитка + отдельная строка прикреплённого стопа (как пишет адаптер). */
async function seedPendingEntry(opts: { orderStatus?: OrderStatus; tradeStatus?: 'open' | 'closed' } = {}): Promise<string> {
  const message = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
      tg_message_id: 777,
      is_topic_message: false,
      text: '1910 limit long ETH',
      has_media: false,
      msg_ts: new Date(),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const action = await db
    .insertInto('actions')
    .values({
      message_id: message.id,
      channel_id: CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side: 'long',
      symbol: 'ETHUSDT',
      method: 'auto',
      status: 'executed',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol: 'ETHUSDT', side: 'long', openedActionId: action.id })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '0.01' })
  await db
    .updateTable('trades')
    .set({ status: opts.tradeStatus ?? 'open', size: '0.01', initial_size: '0.01', leverage: '10', avg_entry: '1910' })
    .where('id', '=', trade.tradeId)
    .execute()

  await db
    .insertInto('orders')
    .values({
      trade_id: trade.tradeId,
      leg_id: leg.legId,
      action_id: action.id,
      channel_id: CHANNEL_ID,
      symbol: 'ETHUSDT',
      order_link_id: LINK_ID,
      purpose: 'entry',
      side: 'long',
      order_type: 'limit',
      qty: '0.01',
      price: '1910',
      status: opts.orderStatus ?? 'submitted',
    })
    .execute()

  await db
    .insertInto('orders')
    .values({
      trade_id: trade.tradeId,
      action_id: action.id,
      channel_id: CHANNEL_ID,
      symbol: 'ETHUSDT',
      order_link_id: `${LINK_ID}-S0`,
      purpose: 'sl',
      side: 'long',
      order_type: 'market',
      reduce_only: true,
      qty: '0.01',
      price: '1738.1',
      status: 'submitted',
    })
    .execute()

  return trade.tradeId
}

function mockRest(): { rest: AmendRestClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  return {
    rest: {
      amendOrder: vi.fn(async (params) => {
        calls.push(params)
        return { ok: true as const }
      }),
    },
    calls,
  }
}

describe('amendPendingEntry — правка отложенного входа', () => {
  it('меняет объём и стоп на бирже и приводит журнал в соответствие', async () => {
    const tradeId = await seedPendingEntry()
    const entry = await findPendingEntry(db, LINK_ID)
    expect(entry).not.toBeNull()
    expect(entry!.qty).toBe('0.0100000000')
    expect(entry!.stopLoss).toBe('1738.1000000000')

    const { rest, calls } = mockRest()
    await amendPendingEntry(db, rest, entry!, { orderLinkId: LINK_ID, qty: '0.10', stopLoss: '1860.1' })

    // Ордер правится ПО orderLinkId — именно это сохраняет связь будущего филла со сделкой.
    expect(calls).toEqual([{ symbol: 'ETHUSDT', orderLinkId: LINK_ID, qty: '0.10', stopLoss: '1860.1' }])

    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', LINK_ID).executeTakeFirstOrThrow()
    expect(order.qty).toBe('0.1000000000')

    // Плановый объём сделки и ноги — тоже: пока входа не было, это «сколько собираемся взять».
    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.size).toBe('0.1000000000')
    expect(trade.initial_size).toBe('0.1000000000')
    const leg = await db.selectFrom('trade_legs').selectAll().where('trade_id', '=', tradeId).executeTakeFirstOrThrow()
    expect(leg.requested_qty).toBe('0.1000000000')

    // Стоп защищает весь вход целиком — у него и цена новая, и объём.
    const sl = await db.selectFrom('orders').selectAll().where('purpose', '=', 'sl').executeTakeFirstOrThrow()
    expect(sl.price).toBe('1860.1000000000')
    expect(sl.qty).toBe('0.1000000000')
  })

  it('отказ биржи НЕ оставляет журнал с цифрами, которых на бирже нет', async () => {
    await seedPendingEntry()
    const entry = await findPendingEntry(db, LINK_ID)
    const rest: AmendRestClient = {
      amendOrder: vi.fn(async () => {
        throw new Error('Bybit: 110094 order not modified')
      }),
    }

    await expect(amendPendingEntry(db, rest, entry!, { orderLinkId: LINK_ID, qty: '0.10' })).rejects.toThrow('110094')

    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', LINK_ID).executeTakeFirstOrThrow()
    expect(order.qty).toBe('0.0100000000') // журнал не тронут
  })

  it('исполненный ордер править нельзя — позиция уже открыта', async () => {
    await seedPendingEntry({ orderStatus: 'filled' })
    const entry = await findPendingEntry(db, LINK_ID)

    const guard = checkAmendGuard(entry!)

    expect(guard.allowed).toBe(false)
    expect(guard.reason).toContain('filled')
  })

  it('закрытую сделку править нельзя — сначала вернуть её в работу', async () => {
    await seedPendingEntry({ tradeStatus: 'closed' })
    const entry = await findPendingEntry(db, LINK_ID)

    const guard = checkAmendGuard(entry!)

    expect(guard.allowed).toBe(false)
    expect(guard.reason).toContain('closed')
  })
})

describe('stopLossForRisk — стоп под заданную долю депозита', () => {
  it('long: убыток по стопу равен риску в процентах от депозита', () => {
    // Ровно случай прода: 0.10 ETH от 1910, депозит 99.84, риск 5% -> убыток 4.992.
    const sl = stopLossForRisk({ side: 'long', entry: '1910', qty: '0.10', equity: '99.84', riskPct: '5' })

    expect(sl.toString()).toBe('1860.08')
    const loss = new Decimal('0.10').mul(new Decimal('1910').minus(sl))
    expect(loss.toFixed(3)).toBe('4.992')
  })

  it('short: стоп уходит ВЫШЕ входа', () => {
    const sl = stopLossForRisk({ side: 'short', entry: '1910', qty: '0.10', equity: '99.84', riskPct: '5' })

    expect(sl.toString()).toBe('1959.92')
  })

  it('чем больше объём, тем ближе стоп при том же риске', () => {
    const small = stopLossForRisk({ side: 'long', entry: '1910', qty: '0.01', equity: '99.84', riskPct: '5' })
    const large = stopLossForRisk({ side: 'long', entry: '1910', qty: '0.10', equity: '99.84', riskPct: '5' })

    expect(large.gt(small)).toBe(true)
  })
})
