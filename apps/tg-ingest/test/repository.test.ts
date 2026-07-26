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
  seedChannelRow,
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

  it('правка существующего сообщения с новым текстом → updated=true, inserted=false', async () => {
    const at = new Date()
    await saveMessage(db, { channelId: 1, tgMessageId: 558, text: 'исходный текст', msgTs: at, raw: {} })

    const edited = await saveMessage(db, {
      channelId: 1,
      tgMessageId: 558,
      text: 'исходный текст [EDITED]',
      msgTs: at,
      raw: {},
      editedTs: at,
    })

    expect(edited.inserted).toBe(false)
    expect(edited.updated).toBe(true)
  })

  it('повторная доставка ИДЕНТИЧНОЙ правки (тот же text и edited_ts) не считается новым изменением', async () => {
    const at = new Date()
    await saveMessage(db, { channelId: 1, tgMessageId: 559, text: 'база', msgTs: at, raw: {} })

    const first = await saveMessage(db, {
      channelId: 1,
      tgMessageId: 559,
      text: 'база [EDITED]',
      msgTs: at,
      raw: {},
      editedTs: at,
    })
    expect(first.inserted).toBe(false)
    expect(first.updated).toBe(true)

    // Пересечение бэкфилла и live-потока (§4/§5 research) может доставить ОДНУ и ту же правку
    // дважды — идемпотентность обязана держать updated=false на повторе, иначе таймлайн ловил
    // бы "обновление" вхолостую при каждой повторной доставке.
    const second = await saveMessage(db, {
      channelId: 1,
      tgMessageId: 559,
      text: 'база [EDITED]',
      msgTs: at,
      raw: {},
      editedTs: at,
    })
    expect(second.inserted).toBe(false)
    expect(second.updated).toBe(false)
  })

  it('чистая повторная доставка без editDate — inserted=false, updated=false', async () => {
    const input = { channelId: 1, tgMessageId: 560, text: 'x', msgTs: new Date(), raw: {} }
    const first = await saveMessage(db, input)
    const second = await saveMessage(db, input)
    expect(first).toMatchObject({ inserted: true, updated: false })
    expect(second).toMatchObject({ inserted: false, updated: false })
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

  // Дефект "правки не обновляются в реальном времени": правка члена уже сохранённого
  // альбома (в т.ч. вырожденного альбома из одного сообщения) обязана породить ОДНУ строку
  // domain_events с type='message.updated' — buildEvent получает kind от saveAlbumWithEvent
  // и сам решает, каким типом события это записать (тот же приём, что и в ingest.service.ts).
  function buildEventByKind(anchorMessageId: string, kind: 'new' | 'updated') {
    return {
      type: kind === 'new' ? 'message.new' : 'message.updated',
      aggregate: 'message',
      payload: { channelId: 1, message: { id: anchorMessageId } },
    }
  }

  it('правка ранее сохранённого сообщения пишет ровно одну строку domain_events с type=message.updated', async () => {
    const original = albumMembers([820], 'g-evt-820')
    const created = await saveAlbumWithEvent(db, original, buildEventByKind)
    expect(created.anyInserted).toBe(true)
    expect(created.anyUpdated).toBe(false)

    const at = new Date()
    const edited = albumMembers([820], 'g-evt-820').map((m) => ({
      ...m,
      text: 'подпись альбома [EDITED]',
      editedTs: at,
    }))

    const editResult = await saveAlbumWithEvent(db, edited, buildEventByKind)
    expect(editResult.anyInserted).toBe(false)
    expect(editResult.anyUpdated).toBe(true)
    expect(editResult.anchorId).toBe(created.anchorId)

    const updatedEvents = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('aggregate_id', '=', created.anchorId)
      .where('type', '=', 'message.updated')
      .execute()
    expect(updatedEvents).toHaveLength(1)

    // Повторная доставка ТОЙ ЖЕ правки (пересечение бэкфилла/live) — событий больше не прибавляет.
    const redelivered = await saveAlbumWithEvent(db, edited, buildEventByKind)
    expect(redelivered.anyInserted).toBe(false)
    expect(redelivered.anyUpdated).toBe(false)

    const { rows } = await sql<{ count: number }>`
      SELECT count(*) FROM domain_events WHERE aggregate_id = ${created.anchorId} AND type = 'message.updated'
    `.execute(db)
    expect(rows[0]?.count).toBe(1)
  })
})

// Водяной знак истории канала (миграция 008). Инцидент прода 25.07.2026: канал засеялся с нулевым
// курсором, бэкфилл вытянул всю историю, и движок разобрал её как свежие сигналы — 2268 вызовов
// AI и реальная позиция на mainnet по сообщению семимесячной давности. Знак ставится РОВНО один
// раз — при первом появлении канала.
describe('seedChannelRow — водяной знак истории', () => {
  const base = {
    ord: 77,
    key: 'seed-watermark',
    sourceKind: 'channel' as const,
    topicId: null,
    adapterId: 'ch1-structured',
    title: 'Канал',
    handle: null,
  }

  async function watermarkOf(id: number): Promise<number> {
    const row = await db.selectFrom('channels').select('process_from_message_id').where('id', '=', id).executeTakeFirstOrThrow()
    return Number(row.process_from_message_id)
  }

  it('новый канал -> знак равен последнему сообщению на момент подключения', async () => {
    const id = 990_001
    await seedChannelRow(db, { ...base, id, ord: 77, key: `k-${id}`, processFromMessageId: 1500 })
    expect(await watermarkOf(id)).toBe(1500)
  })

  it('канал уже заведён со знаком -> повторный сид его НЕ трогает (иначе потеряются накопленные сообщения)', async () => {
    const id = 990_002
    await seedChannelRow(db, { ...base, id, ord: 78, key: `k-${id}`, processFromMessageId: 1500 })
    // Рестарт воркера через сутки: в Telegram уже 1800-е сообщение, но 1501..1800 могли прийти,
    // пока воркер лежал, — их обязан разобрать движок, а не съесть новый водяной знак.
    await seedChannelRow(db, { ...base, id, ord: 78, key: `k-${id}`, title: 'Новое имя', processFromMessageId: 1800 })
    expect(await watermarkOf(id)).toBe(1500)
    const row = await db.selectFrom('channels').select('title').where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.title).toBe('Новое имя') // название при этом обновляется
  })

  it('канал создан сидером api (знак 0 — Telegram ему недоступен) -> tg-ingest проставляет знак', async () => {
    const id = 990_003
    await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
              VALUES (${id}, 79, ${'k-' + id}, 'channel', 'ch1-structured')`.execute(db)
    expect(await watermarkOf(id)).toBe(0)

    await seedChannelRow(db, { ...base, id, ord: 79, key: `k-${id}`, processFromMessageId: 2200 })
    expect(await watermarkOf(id)).toBe(2200)
  })
})
