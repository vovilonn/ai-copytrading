import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { openTrade, acquireSymbol, closeTrade } from '../src/state/trades.js'
import { cleanupDryRunPositions } from '../src/state/cleanup-dryrun.js'

// Разовая чистка фантомных dry_run позиций (задача 3, план 2026-07-12-monitoring-pnl-balance.md,
// Task 3/Task 5: "перед первым live-стартом — разовая чистка 76 фантомных dry_run позиций").
// Засеиваем: open-сделку с позицией size<>0, захваченным symbol_ownership и submitted-ордером ->
// после чистки trade='closed' (is_win=null), size=0, ownership.released_at заполнен,
// ордер='cancelled'. Отдельно засеянная closed-сделка не должна быть тронута. Повторный вызов —
// идемпотентен (0 изменений).

let db: Kysely<DB>
const CHANNEL_ID = 700
let msgSeq = 700_000

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, 1, 'ch-cleanup', 'channel', 'ch1')
  `.execute(db)
})

/** actions.id — FK-якорь orders.action_id (NOT NULL); заводим минимальную цепочку message->action,
 *  тот же приём, что и main-live.test.ts::seedActionId. */
async function seedActionId(symbol: string): Promise<string> {
  const tgMessageId = msgSeq++
  const message = await db
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

  const action = await db
    .insertInto('actions')
    .values({
      message_id: message.id,
      channel_id: CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side: 'long',
      symbol,
      method: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return action.id
}

interface SeedPhantomResult {
  tradeId: string
  symbol: string
  orderLinkId: string
}

/** Заводит полный фантомный dry_run "открытый" трейд: trades.status='open' + позиция size<>0 +
 *  активный symbol_ownership + один submitted-ордер, привязанный к этой сделке. */
async function seedOpenPhantom(symbol: string, status: 'open' | 'partially_closed' = 'open'): Promise<SeedPhantomResult> {
  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol, side: 'long', status })
  await acquireSymbol(db, { channelId: CHANNEL_ID, symbol, tradeId: trade.tradeId })

  await db
    .insertInto('positions')
    .values({ channel_id: CHANNEL_ID, symbol, trade_id: trade.tradeId, side: 'long', size: '150.5', avg_price: '2.5' })
    .execute()

  const actionId = await seedActionId(symbol)
  const orderLinkId = `PHANTOM-${symbol}-${trade.tradeId.slice(0, 8)}`
  await db
    .insertInto('orders')
    .values({
      trade_id: trade.tradeId,
      action_id: actionId,
      channel_id: CHANNEL_ID,
      symbol,
      order_link_id: orderLinkId,
      purpose: 'entry',
      side: 'long',
      order_type: 'limit',
      status: 'submitted',
    })
    .execute()

  return { tradeId: trade.tradeId, symbol, orderLinkId }
}

describe('cleanupDryRunPositions', () => {
  it('open trade + позиция + ownership + submitted-ордер -> closed/size=0/released/cancelled; closed-сделка не тронута', async () => {
    const phantom = await seedOpenPhantom('PHANTOMUSDT')

    // Контрольная уже закрытая сделка — НЕ должна быть тронута чисткой.
    const untouched = await openTrade(db, { channelId: CHANNEL_ID, symbol: 'UNTOUCHEDUSDT', side: 'short' })
    await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: 'UNTOUCHEDUSDT', tradeId: untouched.tradeId })
    await closeTrade(db, { tradeId: untouched.tradeId, realizedPnl: '25' })
    const untouchedBefore = await db.selectFrom('trades').selectAll().where('id', '=', untouched.tradeId).executeTakeFirstOrThrow()

    const report = await cleanupDryRunPositions(db)

    expect(report).toEqual({ tradesClosed: 1, positionsZeroed: 1, ownershipReleased: 1, ordersCancelled: 1 })

    const tradeRow = await db.selectFrom('trades').selectAll().where('id', '=', phantom.tradeId).executeTakeFirstOrThrow()
    expect(tradeRow.status).toBe('closed')
    expect(tradeRow.closed_at).not.toBeNull()
    expect(tradeRow.is_win).toBeNull() // исход неизвестен — принудительное закрытие фантома

    const positionRow = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('symbol', '=', phantom.symbol)
      .executeTakeFirstOrThrow()
    expect(positionRow.size).toBe('0.0000000000')

    const ownershipRow = await db
      .selectFrom('symbol_ownership')
      .selectAll()
      .where('trade_id', '=', phantom.tradeId)
      .executeTakeFirstOrThrow()
    expect(ownershipRow.released_at).not.toBeNull()

    const orderRow = await db.selectFrom('orders').selectAll().where('order_link_id', '=', phantom.orderLinkId).executeTakeFirstOrThrow()
    expect(orderRow.status).toBe('cancelled')
    expect(orderRow.cancelled_at).not.toBeNull()

    // closed-сделка вне выборки чистки — состояние идентично "до".
    const untouchedAfter = await db.selectFrom('trades').selectAll().where('id', '=', untouched.tradeId).executeTakeFirstOrThrow()
    expect(untouchedAfter).toEqual(untouchedBefore)
  })

  it('partially_closed трактуется как открытая (тоже подлежит чистке)', async () => {
    const phantom = await seedOpenPhantom('PARTIALUSDT', 'partially_closed')

    const report = await cleanupDryRunPositions(db)

    expect(report.tradesClosed).toBe(1)
    const tradeRow = await db.selectFrom('trades').select('status').where('id', '=', phantom.tradeId).executeTakeFirstOrThrow()
    expect(tradeRow.status).toBe('closed')
  })

  it('нет открытых сделок -> нулевой отчёт, ничего не трогает', async () => {
    const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol: 'ALREADYCLOSEDUSDT', side: 'long' })
    await closeTrade(db, { tradeId: trade.tradeId })

    const report = await cleanupDryRunPositions(db)

    expect(report).toEqual({ tradesClosed: 0, positionsZeroed: 0, ownershipReleased: 0, ordersCancelled: 0 })
  })

  it('идемпотентна: повторный вызов сразу после первого -> нулевой отчёт (0 изменений)', async () => {
    await seedOpenPhantom('IDEMPOTENTUSDT')

    const first = await cleanupDryRunPositions(db)
    expect(first.tradesClosed).toBe(1)

    const second = await cleanupDryRunPositions(db)
    expect(second).toEqual({ tradesClosed: 0, positionsZeroed: 0, ownershipReleased: 0, ordersCancelled: 0 })
  })

  it('уже cancelled/filled ордера чистка не трогает (только submitted/created/pending_submit/partially_filled)', async () => {
    const phantom = await seedOpenPhantom('ORDERSTATEUSDT')
    const actionId = await seedActionId('ORDERSTATEUSDT')
    await db
      .insertInto('orders')
      .values({
        trade_id: phantom.tradeId,
        action_id: actionId,
        channel_id: CHANNEL_ID,
        symbol: 'ORDERSTATEUSDT',
        order_link_id: 'ALREADY-FILLED-ORDER',
        purpose: 'tp',
        side: 'long',
        order_type: 'limit',
        status: 'filled',
      })
      .execute()

    const report = await cleanupDryRunPositions(db)

    expect(report.ordersCancelled).toBe(1) // только submitted-ордер phantom, не filled
    const filledOrder = await db.selectFrom('orders').select('status').where('order_link_id', '=', 'ALREADY-FILLED-ORDER').executeTakeFirstOrThrow()
    expect(filledOrder.status).toBe('filled')
  })
})
