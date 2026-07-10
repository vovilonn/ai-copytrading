import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import bigInt from 'big-integer'
import { Api } from 'telegram'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { ChannelSource } from 'shared/sources.js'
import { MediaRepairService, type MediaFetcher, type DownloadedMediaResult } from '../src/media-repair.js'

let db: Kysely<DB>

// Источник-фикстура, изолированный от реальных CHANNEL_SOURCES (задача 12b: MediaRepairService
// принимает список источников параметром именно для тестируемости).
const TEST_SOURCE: ChannelSource = {
  channelId: 1n,
  key: 'test-repair',
  ord: 1,
  topicId: null,
  adapterId: 'x',
  sourceKind: 'channel',
}

const photoMedia = () =>
  new Api.MessageMediaPhoto({
    photo: new Api.Photo({
      id: bigInt(1),
      accessHash: bigInt(1),
      fileReference: Buffer.from([]),
      date: 0,
      sizes: [],
      dcId: 1,
    }),
  })

const stickerMedia = () =>
  new Api.MessageMediaDocument({
    document: new Api.Document({
      id: bigInt(1),
      accessHash: bigInt(1),
      fileReference: Buffer.from([]),
      date: 0,
      mimeType: 'application/x-tgsticker',
      size: bigInt(5000),
      dcId: 1,
      attributes: [],
      thumbs: [],
    }),
  })

const fakeMessage = (media: Api.TypeMessageMedia): Api.Message => ({ media }) as unknown as Api.Message

async function insertChannel(): Promise<void> {
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (1, 1, 'test-repair', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
}

interface FixtureMessage {
  tgMessageId: number
  hasMedia: boolean
  groupedId?: string | null
  receivedAt: Date
}

async function insertMessage(f: FixtureMessage): Promise<string> {
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: 1,
      tg_message_id: f.tgMessageId,
      grouped_id: f.groupedId ?? null,
      is_topic_message: false,
      text: '',
      has_media: f.hasMedia,
      media_kind: f.hasMedia ? 'MessageMediaPhoto' : null,
      msg_ts: f.receivedAt,
      received_at: f.receivedAt,
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function mediaRowsFor(messageDbId: string): Promise<Array<{ order_index: number; storage_path: string }>> {
  return db
    .selectFrom('message_media')
    .select(['order_index', 'storage_path'])
    .where('message_id', '=', messageDbId)
    .orderBy('order_index', 'asc')
    .execute()
}

async function repairRowOf(messageDbId: string) {
  return db
    .selectFrom('messages')
    .select(['media_repair_attempts', 'media_repair_failed_at'])
    .where('id', '=', messageDbId)
    .executeTakeFirstOrThrow()
}

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await insertChannel()
})

describe('MediaRepairService', () => {
  it('находит сообщение с has_media и без строки message_media и создаёт строку', async () => {
    const id = await insertMessage({ tgMessageId: 100, hasMedia: true, receivedAt: new Date() })

    const fetcher: MediaFetcher = {
      fetchMessages: vi.fn(async () => [fakeMessage(photoMedia())]),
      downloadMedia: vi.fn(
        async (): Promise<DownloadedMediaResult> => ({
          storagePath: 'var/media/test-repair/100_0.jpg',
          bytes: 42,
          sha256: 'deadbeef',
          mediaType: 'image/jpeg',
        }),
      ),
    }

    const service = new MediaRepairService(db, fetcher, [TEST_SOURCE])
    const summary = await service.run()

    expect(summary.repaired).toBe(1)
    expect(fetcher.fetchMessages).toHaveBeenCalledWith(TEST_SOURCE, [100])

    const rows = await mediaRowsFor(id)
    expect(rows).toEqual([{ order_index: 0, storage_path: 'var/media/test-repair/100_0.jpg' }])
  })

  it('повторный запуск ремонта не создаёт дубль строки медиа', async () => {
    const id = await insertMessage({ tgMessageId: 101, hasMedia: true, receivedAt: new Date() })

    const fetcher: MediaFetcher = {
      fetchMessages: vi.fn(async () => [fakeMessage(photoMedia())]),
      downloadMedia: vi.fn(async () => ({
        storagePath: 'var/media/test-repair/101_0.jpg',
        bytes: 42,
        sha256: 'aaa',
        mediaType: 'image/jpeg',
      })),
    }

    const service = new MediaRepairService(db, fetcher, [TEST_SOURCE])
    await service.run()
    const second = await service.run() // кандидатов уже нет — второй прогон не должен трогать Telegram

    expect(second.scanned).toBe(0)
    expect(fetcher.fetchMessages).toHaveBeenCalledTimes(1)
    const rows = await mediaRowsFor(id)
    expect(rows).toHaveLength(1)
  })

  it('insertMediaRow идемпотентен даже при прямой повторной вставке того же (message_id, order_index)', async () => {
    // Прямая проверка гарантии БД (UNIQUE(message_id, order_index), 002_media_repair.ts) —
    // не полагается на то, что findMediaRepairCandidates исключит уже отремонтированную строку.
    const { insertMediaRow } = await import('../src/repository.js')
    const id = await insertMessage({ tgMessageId: 102, hasMedia: true, receivedAt: new Date() })

    const media = {
      id: crypto.randomUUID(),
      tgMessageId: 102,
      groupedId: null,
      orderIndex: 0,
      storagePath: 'first.jpg',
      mediaType: 'image/jpeg',
      bytes: 1,
      sha256: null,
    }
    const firstInsert = await insertMediaRow(db, id, media)
    const secondInsert = await insertMediaRow(db, id, { ...media, id: crypto.randomUUID(), storagePath: 'second.jpg' })

    expect(firstInsert).toBe(true)
    expect(secondInsert).toBe(false)
    const rows = await mediaRowsFor(id)
    expect(rows).toEqual([{ order_index: 0, storage_path: 'first.jpg' }])
  })

  it('сообщение без скачиваемого медиа (стикер, has_media=false) ремонтом не трогается', async () => {
    const id = await insertMessage({ tgMessageId: 103, hasMedia: false, receivedAt: new Date() })

    const fetcher: MediaFetcher = {
      fetchMessages: vi.fn(async () => [fakeMessage(stickerMedia())]),
      downloadMedia: vi.fn(),
    }

    const service = new MediaRepairService(db, fetcher, [TEST_SOURCE])
    const summary = await service.run()

    expect(summary.scanned).toBe(0)
    expect(fetcher.fetchMessages).not.toHaveBeenCalled()
    const repair = await repairRowOf(id)
    expect(repair.media_repair_attempts).toBe(0)
    expect(repair.media_repair_failed_at).toBeNull()
    expect(await mediaRowsFor(id)).toEqual([])
  })

  it('сообщение с недоступным медиа помечается failed после исчерпания попыток и не крутится вечно', async () => {
    const id = await insertMessage({ tgMessageId: 104, hasMedia: true, receivedAt: new Date() })

    // Сообщение удалено в Telegram — getMessages возвращает "дырку" (undefined) на его месте.
    const fetcher: MediaFetcher = {
      fetchMessages: vi.fn(async () => [undefined]),
      downloadMedia: vi.fn(),
    }

    const maxAttempts = 2
    const service = new MediaRepairService(db, fetcher, [TEST_SOURCE], { maxAttempts })

    await service.run() // попытка 1 — ещё не исчерпано
    let repair = await repairRowOf(id)
    expect(repair.media_repair_attempts).toBe(1)
    expect(repair.media_repair_failed_at).toBeNull()

    await service.run() // попытка 2 — исчерпано, помечается failed
    repair = await repairRowOf(id)
    expect(repair.media_repair_attempts).toBe(2)
    expect(repair.media_repair_failed_at).not.toBeNull()

    // Третий прогон больше не должен трогать Telegram — сообщение исключено из кандидатов.
    const before = (fetcher.fetchMessages as ReturnType<typeof vi.fn>).mock.calls.length
    await service.run()
    expect((fetcher.fetchMessages as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
    expect(await mediaRowsFor(id)).toEqual([])
  })

  it('альбом из N фото даёт N строк message_media с корректными order_index', async () => {
    const base = new Date('2026-01-01T00:00:00Z')
    const ids = await Promise.all(
      [200, 201, 202].map((tgMessageId, i) =>
        insertMessage({
          tgMessageId,
          hasMedia: true,
          groupedId: 'g-album-1',
          receivedAt: new Date(base.getTime() + i * 1000),
        }),
      ),
    )

    const fetcher: MediaFetcher = {
      fetchMessages: vi.fn(async (_source, tgMessageIds: readonly number[]) =>
        tgMessageIds.map(() => fakeMessage(photoMedia())),
      ),
      downloadMedia: vi.fn(async (_source, _msg, _hint, orderIndex: number) => ({
        storagePath: `var/media/test-repair/album_${orderIndex}.jpg`,
        bytes: 10 + orderIndex,
        sha256: `sha-${orderIndex}`,
        mediaType: 'image/jpeg',
      })),
    }

    const service = new MediaRepairService(db, fetcher, [TEST_SOURCE])
    const summary = await service.run()

    expect(summary.repaired).toBe(3)

    for (let i = 0; i < 3; i++) {
      const rows = await mediaRowsFor(ids[i]!)
      expect(rows).toEqual([{ order_index: i, storage_path: `var/media/test-repair/album_${i}.jpg` }])
    }
  })
})
