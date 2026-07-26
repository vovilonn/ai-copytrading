import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { addLeg, openTrade, acquireSymbol } from '../src/state/trades.js'
import { checkResetGuard, previewResetJournal, resetJournal } from '../src/state/reset-journal.js'

// Разовая чистка журнала после инцидента прода 25.07.2026 (история канала прогналась через
// пайплайн как свежие сигналы). Проверяется ровно то, что легко сломать: порядок удаления при
// циклическом FK (actions ↔ trades) и отказ работать при живой позиции.

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

beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id, process_from_message_id)
    VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch1', 'channel', 'ch1', 0)
  `.execute(db)
})

/** Полный след одного обработанного сообщения: сообщение → разбор → действие → сделка → ордер. */
async function seedProcessedMessage(tgMessageId: number, status: 'open' | 'closed'): Promise<{ messageId: string; tradeId: string }> {
  const message = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
      tg_message_id: tgMessageId,
      is_topic_message: false,
      text: 'сигнал',
      has_media: false,
      msg_ts: new Date(),
      raw: JSON.stringify({}),
      status: 'executed',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db
    .insertInto('parse_results')
    .values({
      message_id: message.id,
      parser: 'deterministic',
      adapter_id: 'ch1',
      route: 'execute',
      confidence: '1',
      intents: JSON.stringify([]),
      needs_vision: false,
    })
    .execute()

  const action = await db
    .insertInto('actions')
    .values({
      message_id: message.id,
      channel_id: CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side: 'long',
      symbol: 'BTCUSDT',
      method: 'auto',
      status: 'executed',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol: 'BTCUSDT', side: 'long', openedActionId: action.id })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '1' })
  await db.updateTable('trades').set({ status, size: status === 'open' ? '1' : '0' }).where('id', '=', trade.tradeId).execute()

  const order = await db
    .insertInto('orders')
    .values({
      trade_id: trade.tradeId,
      leg_id: leg.legId,
      action_id: action.id,
      channel_id: CHANNEL_ID,
      symbol: 'BTCUSDT',
      order_link_id: `K01-${tgMessageId}-00-E0`,
      purpose: 'entry',
      side: 'long',
      order_type: 'market',
      status: 'filled',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db
    .insertInto('executions')
    .values({
      trade_id: trade.tradeId,
      leg_id: leg.legId,
      order_id: order.id,
      bybit_exec_id: `exec-${tgMessageId}`,
      order_link_id: `K01-${tgMessageId}-00-E0`,
      symbol: 'BTCUSDT',
      side: 'long',
      exec_qty: '1',
      exec_price: '100',
      exec_ts: new Date(),
    })
    .execute()

  if (status === 'open') {
    await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: 'BTCUSDT', tradeId: trade.tradeId })
  }
  await db
    .insertInto('positions')
    .values({
      channel_id: CHANNEL_ID,
      symbol: 'BTCUSDT',
      trade_id: trade.tradeId,
      side: 'long',
      size: status === 'open' ? '1' : '0',
      avg_price: '100',
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(['channel_id', 'symbol']).doUpdateSet((eb) => ({ size: eb.ref('excluded.size'), trade_id: eb.ref('excluded.trade_id') })),
    )
    .execute()

  return { messageId: message.id, tradeId: trade.tradeId }
}

describe('resetJournal — разовая чистка торгового журнала', () => {
  it('сносит действия/сделки/ордера/исполнения, но СОХРАНЯЕТ сообщения и переводит их в archived', async () => {
    await seedProcessedMessage(100, 'closed')
    await seedProcessedMessage(101, 'closed')

    const preview = await previewResetJournal(db)
    expect(preview.actions).toBe(2)
    expect(preview.orders).toBe(2)

    const summary = await resetJournal(db)

    expect(summary.actions).toBe(2)
    expect(summary.trades).toBe(2)
    expect(summary.orders).toBe(2)
    expect(summary.executions).toBe(2)
    expect(summary.parseResults).toBe(2)
    expect(summary.archivedMessages).toBe(2)

    // Сообщения остались — их подтянули, и они нужны оператору и бэктесту.
    const messages = await db.selectFrom('messages').selectAll().execute()
    expect(messages).toHaveLength(2)
    expect(messages.every((m) => m.status === 'archived')).toBe(true)
    expect(messages.every((m) => m.status_reason === 'historical_backlog')).toBe(true)

    // Водяной знак поднят до последнего подтянутого сообщения — движок к этой истории не вернётся.
    expect(summary.watermarks).toEqual([{ channelId: CHANNEL_ID, processFromMessageId: 101 }])

    for (const table of ['actions', 'trades', 'orders', 'executions', 'trade_legs', 'symbol_ownership'] as const) {
      const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(db)
      expect(`${table}=${rows[0]!.n}`).toBe(`${table}=0`)
    }
  })

  it('отказывается работать при незакрытой сделке — иначе позиция на бирже осталась бы без управления', async () => {
    await seedProcessedMessage(200, 'open')

    const guard = await checkResetGuard(db)

    expect(guard.allowed).toBe(false)
    expect(guard.reason).toContain('незакрытых сделок')
  })

  it('отказывается работать при ненулевой позиции в зеркале, даже если сделка закрыта', async () => {
    const { tradeId } = await seedProcessedMessage(300, 'closed')
    await db.updateTable('positions').set({ size: '5' }).where('trade_id', '=', tradeId).execute()

    const guard = await checkResetGuard(db)

    expect(guard.allowed).toBe(false)
    expect(guard.reason).toContain('ненулевых позиций')
  })

  it('не понижает уже выставленный водяной знак канала', async () => {
    await db.updateTable('channels').set({ process_from_message_id: 9_000 }).where('id', '=', CHANNEL_ID).execute()
    await seedProcessedMessage(100, 'closed')

    const summary = await resetJournal(db)

    expect(summary.watermarks).toEqual([{ channelId: CHANNEL_ID, processFromMessageId: 9_000 }])
  })
})
