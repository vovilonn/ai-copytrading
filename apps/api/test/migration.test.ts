import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'

let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  // Тесты идемпотентны: гоняются повторно против той же живой БД,
  // поэтому чистим фикстуры перед каждым прогоном (бриф, п.7).
  await sql`TRUNCATE symbol_ownership, trade_legs, trades, actions, messages, channel_settings, channels RESTART IDENTITY CASCADE;`.execute(
    db,
  )
})
afterAll(async () => {
  await db.destroy()
})

it('создаёт все таблицы схемы', async () => {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `.execute(db)
  const names = rows.map((r) => r.table_name)
  for (const t of [
    'users', 'channels', 'channel_settings', 'messages', 'message_media',
    'processed_messages', 'parse_results', 'ai_calls', 'ai_cache', 'actions',
    'trades', 'trade_legs', 'orders', 'executions', 'symbol_ownership',
    'positions', 'instruments', 'domain_events', 'audit_log', 'app_state',
  ]) expect(names).toContain(t)
})

it('запрещает два сообщения с одним tg_message_id в канале', async () => {
  // ord=991 — заведомо вне диапазона реальных источников (SOURCES использует ord=1,2, см.
  // apps/tg-ingest/src/sources.ts), иначе UNIQUE(ord) конфликтует с сидом ingest.service.ts
  // при совместном запуске тестов обоих пакетов (pnpm test в корне).
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (1, 991, 'test', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  const ins = sql`INSERT INTO messages (channel_id, tg_message_id, msg_ts, raw)
                  VALUES (1, 100, now(), '{}'::jsonb)`
  await ins.execute(db)
  await expect(ins.execute(db)).rejects.toThrow(/duplicate key/)
})

it('разрешает двум каналам владеть одним символом', async () => {
  // субаккаунт на канал ⇒ владение уникально по (channel_id, symbol)
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (2, 992, 'test2', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  // nextval вызывается один раз (через CTE) и это же значение идёт и в human_ref, и в seq —
  // два отдельных вызова nextval() дали бы разные числа (human_ref='TR-1058' при seq=1059).
  const trade = async (ch: number) => {
    const { rows } = await sql<{ id: string; human_ref: string; seq: number }>`
      WITH s AS (SELECT nextval('trade_ref_seq') AS n)
      INSERT INTO trades (human_ref, seq, channel_id, symbol, side)
      SELECT 'TR-' || s.n, s.n, ${ch}, 'SOLUSDT', 'long' FROM s
      RETURNING id, human_ref, seq`.execute(db)
    return rows[0]!
  }
  const own = (ch: number, tid: string) => sql`
    INSERT INTO symbol_ownership (symbol, channel_id, trade_id) VALUES ('SOLUSDT', ${ch}, ${tid})`.execute(db)
  const trade1 = await trade(1)
  const trade2 = await trade(2)
  // согласованность: human_ref обязан выводиться из того же значения nextval, что и seq
  expect(trade1.human_ref).toBe('TR-' + trade1.seq)
  expect(trade2.human_ref).toBe('TR-' + trade2.seq)
  await own(1, trade1.id)
  await expect(own(2, trade2.id)).resolves.toBeDefined()
})

it('BIGINT читается через Kysely как number, NUMERIC — остаётся string', async () => {
  // id канала Telegram (~2*10^9) заведомо меньше Number.MAX_SAFE_INTEGER
  const channelId = 2088626562
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (${channelId}, 993, 'test-bigint', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)

  const channel = await db
    .selectFrom('channels')
    .select(['id'])
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow()
  expect(typeof channel.id).toBe('number')
  expect(channel.id).toBe(channelId)

  // NUMERIC (деньги/размеры) обязан остаться строкой — иначе теряется точность на ценах
  await sql`INSERT INTO channel_settings (channel_id, trade_size, max_leverage)
            VALUES (${channelId}, '500', '10') ON CONFLICT DO NOTHING`.execute(db)

  const settings = await db
    .selectFrom('channel_settings')
    .select(['trade_size'])
    .where('channel_id', '=', channelId)
    .executeTakeFirstOrThrow()
  expect(typeof settings.trade_size).toBe('string')
  expect(Number(settings.trade_size)).toBe(500)
})
