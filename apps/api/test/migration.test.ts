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
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (1, 1, 'test', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  const ins = sql`INSERT INTO messages (channel_id, tg_message_id, msg_ts, raw)
                  VALUES (1, 100, now(), '{}'::jsonb)`
  await ins.execute(db)
  await expect(ins.execute(db)).rejects.toThrow(/duplicate key/)
})

it('разрешает двум каналам владеть одним символом', async () => {
  // субаккаунт на канал ⇒ владение уникально по (channel_id, symbol)
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (2, 2, 'test2', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  const trade = async (ch: number) => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO trades (human_ref, seq, channel_id, symbol, side)
      VALUES ('TR-' || nextval('trade_ref_seq'), nextval('trade_ref_seq'), ${ch}, 'SOLUSDT', 'long')
      RETURNING id`.execute(db)
    return rows[0]!.id
  }
  const own = (ch: number, tid: string) => sql`
    INSERT INTO symbol_ownership (symbol, channel_id, trade_id) VALUES ('SOLUSDT', ${ch}, ${tid})`.execute(db)
  await own(1, await trade(1))
  await expect(own(2, await trade(2))).resolves.toBeDefined()
})
