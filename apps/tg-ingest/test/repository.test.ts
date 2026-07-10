import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import {
  saveMessage,
  saveMessageWithEvent,
  saveAlbumWithEvent,
  advanceCursor,
  getCursor,
  type AlbumMemberInput,
} from '../src/repository.js'

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

  it('первая вставка сообщения с уже проставленным editedTs — это НЕ конфликт, inserted=true', async () => {
    // Регрессия: Telegram-сообщение может нести editDate ещё до того, как мы впервые его увидели
    // (канал правил его сам до нашего бэкфилла) — сама по себе editedTs≠null не означает, что
    // строка уже существовала в НАШЕЙ БД. inserted обязан отражать, вставила ли именно ЭТА
    // команда новую строку (ON CONFLICT DO UPDATE не сработал за отсутствием конфликта),
    // а не "входящее сообщение помечено как правка" — иначе outbox молча теряет событие
    // для примерно каждого 2-го сообщения форума (см. LOOP_STATE.md: 24 из 25 имеют editDate).
    const at = new Date()
    const result = await saveMessage(db, {
      channelId: 1,
      tgMessageId: 557,
      text: 'уже редактировался в Telegram до нас',
      msgTs: at,
      raw: {},
      editedTs: at,
    })
    expect(result.inserted).toBe(true)

    // А вот повторная доставка ТОГО ЖЕ сообщения (конфликт по channel_id+tg_message_id,
    // реально сработавший ON CONFLICT DO UPDATE) — уже не новая строка.
    const second = await saveMessage(db, {
      channelId: 1,
      tgMessageId: 557,
      text: 'та же правка ещё раз',
      msgTs: at,
      raw: {},
      editedTs: at,
    })
    expect(second.inserted).toBe(false)
    expect(second.id).toBe(result.id)
  })
})

describe('cursor', () => {
  it('курсор двигается только вперёд', async () => {
    await advanceCursor(db, 1, 100)
    await advanceCursor(db, 1, 50) // бэкфилл принёс старое — курсор не откатывается
    expect(await getCursor(db, 1)).toBe(100)
  })
})

describe('saveMessageWithEvent', () => {
  it('новое сообщение порождает строку domain_events в той же транзакции', async () => {
    const payload = { channelId: 1, message: { text: 'событие' } }
    const saved = await saveMessageWithEvent(
      db,
      { channelId: 1, tgMessageId: 700, text: 'x', msgTs: new Date(), raw: {} },
      null,
      { type: 'message.new', aggregate: 'message', payload },
    )
    expect(saved.inserted).toBe(true)

    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', saved.id)
      .executeTakeFirstOrThrow()
    expect(event.type).toBe('message.new')
    expect(event.aggregate).toBe('message')
    expect(event.published_at).toBeNull()
    expect(event.payload).toEqual(payload)
  })

  it('первая вставка сообщения с editedTs≠null (правка Telegram ДО нашего бэкфилла) тоже порождает событие', async () => {
    const at = new Date()
    const payload = { channelId: 1, message: { text: 'форумное сообщение с историей правок' } }
    const saved = await saveMessageWithEvent(
      db,
      { channelId: 1, tgMessageId: 705, text: 'z', msgTs: at, raw: {}, editedTs: at },
      null,
      { type: 'message.new', aggregate: 'message', payload },
    )
    expect(saved.inserted).toBe(true)

    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', saved.id)
      .executeTakeFirst()
    expect(event).toBeDefined()
    expect(event?.payload).toEqual(payload)
  })

  it('повторная доставка (inserted=false) не создаёт событие', async () => {
    const input = { channelId: 1, tgMessageId: 701, text: 'y', msgTs: new Date(), raw: {} }
    const event = { type: 'message.new', aggregate: 'message', payload: { channelId: 1 } }
    const first = await saveMessageWithEvent(db, input, null, event)
    const second = await saveMessageWithEvent(db, input, null, event)
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)

    // count(*) — BIGINT, читается числом (см. pg.types.setTypeParser(INT8) в api/db/database.ts).
    const { rows } = await sql<{ count: number }>`
      SELECT count(*) FROM domain_events WHERE aggregate_id = ${second.id}
    `.execute(db)
    expect(rows[0]?.count).toBe(1)
  })

  it('правка (editedTs задан) не создаёт событие', async () => {
    const at = new Date()
    const event = { type: 'message.new', aggregate: 'message', payload: { channelId: 1 } }
    const created = await saveMessageWithEvent(
      db,
      { channelId: 1, tgMessageId: 702, text: 'v1', msgTs: at, raw: {} },
      null,
      event,
    )
    const edited = await saveMessageWithEvent(
      db,
      { channelId: 1, tgMessageId: 702, text: 'v2', msgTs: at, raw: {}, editedTs: at },
      null,
      event,
    )
    expect(created.inserted).toBe(true)
    expect(edited.inserted).toBe(false)

    const { rows } = await sql<{ count: number }>`
      SELECT count(*) FROM domain_events WHERE aggregate_id = ${created.id}
    `.execute(db)
    expect(rows[0]?.count).toBe(1)
  })

  it('строка медиа сохраняется вместе с сообщением, повтор не плодит дубль', async () => {
    const media = {
      id: crypto.randomUUID(),
      tgMessageId: 703,
      groupedId: null,
      orderIndex: 0,
      storagePath: 'var/media/test/703_0.jpg',
      mediaType: 'image/jpeg',
      bytes: 123,
      sha256: 'abc',
    }
    const event = { type: 'message.new', aggregate: 'message', payload: { channelId: 1 } }
    const input = { channelId: 1, tgMessageId: 703, text: 'z', hasMedia: true, msgTs: new Date(), raw: {} }

    const saved = await saveMessageWithEvent(db, input, media, event)
    // Повторная доставка того же сообщения+медиа (пересечение бэкфилла и live) — дедуп внутри транзакции.
    await saveMessageWithEvent(db, input, { ...media, id: crypto.randomUUID() }, event)

    const rows = await db
      .selectFrom('message_media')
      .selectAll()
      .where('message_id', '=', saved.id)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.storage_path).toBe(media.storagePath)
  })
})

describe('saveAlbumWithEvent', () => {
  // Дефект Ф0 (task-12c): Telegram доставляет альбом N отдельными сообщениями с общим
  // grouped_id — ingest продолжает писать N строк messages (нужно для дедупа/резолва reply),
  // но domain_events должен получить РОВНО ОДНУ строку на весь альбом (иначе websocket
  // 'message.new' уходит N раз и таймлайн рисует N узлов вместо одного).
  function albumMembers(tgMessageIds: number[], groupedId: string): AlbumMemberInput[] {
    return tgMessageIds.map((tgMessageId, i) => ({
      channelId: 1,
      tgMessageId,
      groupedId,
      // Подпись Telegram лежит ровно на одном элементе группы — здесь на среднем.
      text: i === 1 ? 'подпись альбома' : '',
      msgTs: new Date(),
      raw: {},
      media: null,
    }))
  }

  it('альбом из N сообщений порождает ровно одну строку в domain_events', async () => {
    const members = albumMembers([800, 801, 802], 'g-evt-800')
    const buildEvent = (anchorMessageId: string) => ({
      type: 'message.new',
      aggregate: 'message',
      payload: { channelId: 1, message: { id: anchorMessageId, tgMessageId: 800 } },
    })

    const { anchorId, anyInserted } = await saveAlbumWithEvent(db, members, buildEvent)
    expect(anyInserted).toBe(true)

    // Все 3 строки messages реально вставлены (дедуп/reply не сломан).
    const messageRows = await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', 1)
      .where('grouped_id', '=', 'g-evt-800')
      .execute()
    expect(messageRows).toHaveLength(3)

    // Ровно ОДНА строка domain_events на весь альбом — не по одной на сообщение.
    const events = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', anchorId)
      .execute()
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('message.new')

    const { rows } = await sql<{ count: number }>`
      SELECT count(*) FROM domain_events WHERE aggregate_id = ANY(${messageRows.map((r) => r.id)})
    `.execute(db)
    expect(rows[0]?.count).toBe(1)

    // Якорь — сообщение с МИНИМАЛЬНЫМ tg_message_id группы (монотонная пагинация по before=).
    const anchorRow = await db.selectFrom('messages').select('tg_message_id').where('id', '=', anchorId).executeTakeFirstOrThrow()
    expect(anchorRow.tg_message_id).toBe(800)
  })

  it('повторная доставка всего альбома (все сообщения уже существуют) не создаёт второе событие', async () => {
    const members = albumMembers([810, 811], 'g-evt-810')
    const buildEvent = () => ({ type: 'message.new', aggregate: 'message', payload: { channelId: 1 } })

    const first = await saveAlbumWithEvent(db, members, buildEvent)
    expect(first.anyInserted).toBe(true)

    const second = await saveAlbumWithEvent(db, members, buildEvent)
    expect(second.anyInserted).toBe(false)

    const { rows } = await sql<{ count: number }>`
      SELECT count(*) FROM domain_events WHERE aggregate_id = ${first.anchorId}
    `.execute(db)
    expect(rows[0]?.count).toBe(1)
  })
})
