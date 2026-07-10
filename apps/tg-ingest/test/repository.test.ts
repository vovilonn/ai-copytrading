import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { saveMessage, advanceCursor, getCursor } from '../src/repository.js'

let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  // Тесты идемпотентны: гоняются повторно против той же тестовой БД (copytrade_test),
  // поэтому чистим фикстуры перед каждым прогоном (аналогично apps/api/test/migration.test.ts).
  await resetTestSchema(db)
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (1, 1, 'test', 'channel', 'x')`.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

describe('saveMessage', () => {
  it('повторная доставка того же сообщения не создаёт дубль', async () => {
    const input = { channelId: 1, tgMessageId: 555, text: 'x', msgTs: new Date(), raw: {} }
    const first = await saveMessage(db, input)
    const second = await saveMessage(db, input)
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('правка помечает сообщение и увеличивает счётчик', async () => {
    const at = new Date()
    await saveMessage(db, { channelId: 1, tgMessageId: 556, text: 'v1', msgTs: at, raw: {} })
    await saveMessage(db, { channelId: 1, tgMessageId: 556, text: 'v2', msgTs: at, raw: {}, editedTs: at })
    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('channel_id', '=', 1)
      .where('tg_message_id', '=', 556)
      .executeTakeFirstOrThrow()
    expect(row.text).toBe('v2')
    expect(row.edit_count).toBe(1)
  })
})

describe('cursor', () => {
  it('курсор двигается только вперёд', async () => {
    await advanceCursor(db, 1, 100)
    await advanceCursor(db, 1, 50) // бэкфилл принёс старое — курсор не откатывается
    expect(await getCursor(db, 1)).toBe(100)
  })
})
