import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import type { ChannelDto, MessageDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

// message_media.storage_path хранится относительно корня репозитория (см.
// apps/api/src/channels/media.controller.ts) — фикстура пишется туда же, в var/ (gitignore),
// чтобы проверить именно резолв относительного пути, как в проде.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE_REL_PATH = 'var/media/test-fixture/media.jpg'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Те же 2 канала, что сидирует ChannelSeedService при старте приложения (см.
// apps/api/src/channels/channel-seed.service.ts) и apps/tg-ingest/src/ingest.service.ts —
// оба берут их из единого источника packages/shared/src/sources.ts.
const CHANNEL_1_ID = Number(CHANNEL_SOURCES[0]!.channelId)
const CHANNEL_1_KEY = CHANNEL_SOURCES[0]!.key
const CHANNEL_2_KEY = CHANNEL_SOURCES[1]!.key

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует 2 канала, AuthService — админа

  // Фикстуры сообщений создаём сами (бриф: не полагаться на dev-данные) поверх засеянного канала.
  for (let i = 1; i <= 5; i++) {
    await db
      .insertInto('messages')
      .values({
        channel_id: CHANNEL_1_ID,
        tg_message_id: 1000 + i,
        is_topic_message: false,
        text: `сигнал #${i}`,
        has_media: false,
        msg_ts: new Date(Date.UTC(2026, 0, 1, 12, i, 0)),
        raw: JSON.stringify({}),
      })
      .execute()
  }

  agent = request.agent(app.getHttpServer())
  await agent.post('/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

it('GET /channels без куки -> 401', async () => {
  const res = await request(app.getHttpServer()).get('/channels')
  expect(res.status).toBe(401)
})

it('GET /channels возвращает оба засеянных канала', async () => {
  const res = await agent.get('/channels').expect(200)
  const channels = res.body as ChannelDto[]
  expect(channels).toHaveLength(2)
  expect(channels.map((c) => c.key).sort()).toEqual([CHANNEL_2_KEY, CHANNEL_1_KEY].sort())

  const ch1 = channels.find((c) => c.key === CHANNEL_1_KEY)!
  expect(ch1.id).toBe(CHANNEL_1_ID)
  expect(ch1.winRate).toBe('—')
  expect(ch1.tradeSize).toBe('$500')
  expect(ch1.maxLeverage).toBe('10x')
  expect(ch1.messageCount).toBe(5)
  expect(ch1.actionCount).toBe(0)
  expect(ch1.activePositions).toBe(0)
  expect(typeof ch1.initial).toBe('string')
  expect(ch1.initial.length).toBe(1)
})

it('GET /channels/:id отдаёт один канал в том же формате', async () => {
  const res = await agent.get(`/channels/${CHANNEL_1_ID}`).expect(200)
  const channel = res.body as ChannelDto
  expect(channel.id).toBe(CHANNEL_1_ID)
  expect(channel.key).toBe(CHANNEL_1_KEY)
})

it('GET /channels/999999 -> 404', async () => {
  await agent.get('/channels/999999').expect(404)
})

it('GET /channels/:id/messages?limit=3 отдаёт ровно 3 записи по убыванию tgMessageId', async () => {
  const res = await agent.get(`/channels/${CHANNEL_1_ID}/messages?limit=3`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages).toHaveLength(3)
  const ids = messages.map((m) => m.tgMessageId)
  expect(ids).toEqual([1005, 1004, 1003])
  for (const m of messages) {
    expect(m.actions).toEqual([])
    expect(Array.isArray(m.media)).toBe(true)
    expect(() => new Date(m.time).toISOString()).not.toThrow()
  }
})

it('GET /channels/:id/messages?limit=3&before=1004 продолжает пагинацию', async () => {
  const res = await agent.get(`/channels/${CHANNEL_1_ID}/messages?limit=3&before=1004`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages.map((m) => m.tgMessageId)).toEqual([1003, 1002, 1001])
})

it('GET /channels/:id/messages с некорректными limit/before откатывается к дефолту, а не 500', async () => {
  const res = await agent.get(`/channels/${CHANNEL_1_ID}/messages?limit=abc&before=xyz`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages.map((m) => m.tgMessageId)).toEqual([1005, 1004, 1003, 1002, 1001])
})

describe('GET /media/:id', () => {
  let mediaId: string
  const fixtureBytes = Buffer.from('fake-jpeg-bytes')

  beforeAll(async () => {
    const message = await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', CHANNEL_1_ID)
      .where('tg_message_id', '=', 1001)
      .executeTakeFirstOrThrow()

    const absPath = path.join(REPO_ROOT, FIXTURE_REL_PATH)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, fixtureBytes)

    const row = await db
      .insertInto('message_media')
      .values({
        id: crypto.randomUUID(),
        message_id: message.id,
        tg_message_id: 1001,
        grouped_id: null,
        order_index: 0,
        storage_path: FIXTURE_REL_PATH,
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: fixtureBytes.length,
        sha256: null,
        created_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    mediaId = row.id
  })

  afterAll(async () => {
    await fs.rm(path.join(REPO_ROOT, 'var/media/test-fixture'), { recursive: true, force: true })
  })

  it('отдаёт файл по storage_path потоком с корректным Content-Type', async () => {
    const res = await agent.get(`/media/${mediaId}`).expect(200)
    expect(res.headers['content-type']).toContain('image/jpeg')
    expect(Buffer.from(res.body as Buffer).equals(fixtureBytes)).toBe(true)
  })

  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get(`/media/${mediaId}`)
    expect(res.status).toBe(401)
  })

  it('несуществующий id -> 404', async () => {
    await agent.get('/media/00000000-0000-0000-0000-000000000000').expect(404)
  })

  it('некорректный (не-UUID) id -> 404, а не 500', async () => {
    await agent.get('/media/not-a-uuid').expect(404)
  })
})
