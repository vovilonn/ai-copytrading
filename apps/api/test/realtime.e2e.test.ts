import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { io, type Socket } from 'socket.io-client'
import { sql, type Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import type { MessageNewPayload, MessageUpdatedPayload } from 'shared/ws-events.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Тот же канал, что сидирует ChannelSeedService при старте приложения (packages/shared/src/sources.ts).
const CHANNEL_ID = Number(CHANNEL_SOURCES[0]!.channelId)

let app: INestApplication
let db: Kysely<DB>
let baseUrl: string
let sessionCookie: string

/** Ждёт ровно одно из перечисленных событий сокета, иначе падает по таймауту. */
function waitForEvent<T = unknown>(socket: Socket, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`таймаут ожидания "${event}"`)), timeoutMs)
    socket.once(event, (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init()
  await app.listen(0) // случайный свободный порт — нужен реальный TCP-листенер для socket.io-client

  const address = app.getHttpServer().address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`

  const agent = request.agent(app.getHttpServer())
  const res = await agent
    .post('/api/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    .expect(204)
  const setCookie = res.headers['set-cookie']
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!cookieHeader) throw new Error('POST /auth/login не поставил куку сессии')
  sessionCookie = cookieHeader
})

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('realtime gateway', () => {
  it('без куки — сервер отклоняет соединение на хендшейке', async () => {
    const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true })
    try {
      // Проверка куки перенесена в middleware хендшейка (io.use, см. realtime.gateway.ts) — сервер
      // теперь обрывает попытку ДО того, как соединение успевает установиться, поэтому клиент
      // получает connect_error, а не connect + disconnect (последнего в этом сценарии больше не
      // бывает вовсе). Ждём именно connect_error — не просто отсутствие события (иначе тест был бы
      // зелёным и без guard'а вовсе).
      await waitForEvent(socket, 'connect_error', 10_000)
    } finally {
      socket.close()
    }
  }, 15_000)

  it('с валидной кукой — подключается и получает message.new после INSERT + pg_notify', async () => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { cookie: sessionCookie },
    })

    try {
      await waitForEvent(socket, 'connect', 10_000)

      socket.emit('channel.subscribe', CHANNEL_ID)

      const eventPromise = waitForEvent<MessageNewPayload>(socket, 'message.new', 10_000)

      const tgMessageId = 424242
      const text = 'живое событие realtime-теста'
      const msgTs = new Date()

      const messageRow = await db
        .insertInto('messages')
        .values({
          channel_id: CHANNEL_ID,
          tg_message_id: tgMessageId,
          is_topic_message: false,
          text,
          has_media: false,
          msg_ts: msgTs,
          raw: JSON.stringify({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      const payload: MessageNewPayload = {
        channelId: CHANNEL_ID,
        message: {
          id: messageRow.id,
          tgMessageId,
          time: msgTs.toISOString(),
          text,
          media: [],
          aiSummary: null,
          actions: [],
          method: null,
          status: 'received',
        },
      }

      await db
        .insertInto('domain_events')
        .values({
          type: 'message.new',
          aggregate: 'message',
          aggregate_id: messageRow.id,
          payload: JSON.stringify(payload),
        })
        .execute()

      await sql`SELECT pg_notify('domain_events', '')`.execute(db)

      const received = await eventPromise
      expect(received.channelId).toBe(CHANNEL_ID)
      expect(received.message.id).toBe(messageRow.id)
      expect(received.message.tgMessageId).toBe(tgMessageId)
      expect(received.message.text).toBe(text)
      expect(received.message.media).toEqual([])
      expect(received.message.actions).toEqual([])

      // Строка обязана быть отмечена опубликованной — иначе периодический опрос будет слать
      // её повторно бесконечно (outbox-инвариант, task-9-brief §3). publisher рассылает событие
      // ДО того, как UPDATE published_at закоммитится (иначе при крэше между emit и UPDATE
      // событие потерялось бы навсегда) — клиент может получить message.new на миг раньше,
      // чем эта строка станет видна снаружи, поэтому ждём с коротким поллингом, а не одной проверкой.
      await expect
        .poll(
          async () => {
            const row = await db
              .selectFrom('domain_events')
              .select('published_at')
              .where('aggregate_id', '=', messageRow.id)
              .executeTakeFirstOrThrow()
            return row.published_at
          },
          { timeout: 5000, interval: 50 },
        )
        .not.toBeNull()
    } finally {
      socket.close()
    }
  }, 15_000)

  // Реалтайм разбора: сообщение прилетает в UI сразу (message.new от tg-ingest), а действия и
  // AI-саммари дописывает движок ПОЗЖЕ. Раньше про это никто фронту не сообщал — узел таймлайна
  // так и оставался пустым до перезагрузки страницы. Теперь движок шлёт 'message.processed'
  // (он знает только id), а outbox ПЕРЕСОБИРАЕТ узел и рассылает готовый 'message.updated'.
  it('message.processed от движка -> клиент получает message.updated с собранными действиями', async () => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { cookie: sessionCookie },
    })

    try {
      await waitForEvent(socket, 'connect', 10_000)
      socket.emit('channel.subscribe', CHANNEL_ID)

      const msgTs = new Date()
      const messageRow = await db
        .insertInto('messages')
        .values({
          channel_id: CHANNEL_ID,
          tg_message_id: 424243,
          is_topic_message: false,
          text: '#SOL/USDT LONG',
          has_media: false,
          msg_ts: msgTs,
          raw: JSON.stringify({}),
          status: 'skipped',
          status_reason: 'no_SL',
          method: 'auto',
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await db
        .insertInto('actions')
        .values({
          message_id: messageRow.id,
          channel_id: CHANNEL_ID,
          action_index: 0,
          type: 'open',
          side: 'long',
          symbol: 'SOLUSDT',
          pair: 'SOLUSDT',
          method: 'auto',
          status: 'skipped',
          skip_reason: 'no_SL',
        })
        .execute()

      const eventPromise = waitForEvent<MessageUpdatedPayload>(socket, 'message.updated', 10_000)

      await db
        .insertInto('domain_events')
        .values({
          type: 'message.processed',
          aggregate: 'message',
          aggregate_id: messageRow.id,
          payload: JSON.stringify({ channelId: CHANNEL_ID, messageId: messageRow.id }),
        })
        .execute()
      await sql`SELECT pg_notify('domain_events', '')`.execute(db)

      const received = await eventPromise
      expect(received.message.id).toBe(messageRow.id)
      // Узел собран целиком: статус (фронт снимет лоадер) и действие с причиной пропуска.
      expect(received.message.status).toBe('skipped')
      expect(received.message.actions).toHaveLength(1)
      expect(received.message.actions[0]!.skipReason).toBe('no_SL')
    } finally {
      socket.close()
    }
  }, 15_000)
})
