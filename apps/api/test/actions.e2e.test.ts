import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { ActionRowDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Те же 2 канала, что сидирует ChannelSeedService при старте приложения (packages/shared/src/sources.ts),
// тот же приём, что и channels.e2e.test.ts/realtime.e2e.test.ts.
const CHANNEL_A_ID = Number(CHANNEL_SOURCES[0]!.channelId)
const CHANNEL_B_ID = Number(CHANNEL_SOURCES[1]!.channelId)

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует 2 канала, AuthService — админа

  const msgA = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_A_ID,
      tg_message_id: 5001,
      is_topic_message: false,
      text: '#BTC/USDT Long\nEntry 62400\nTP 64000\nSL 61500',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const msgB = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_B_ID,
      tg_message_id: 6001,
      is_topic_message: false,
      text: 'ETH/USDT short',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 0, 1, 12, 5, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const tradeBtc = await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-9001',
      seq: 9001,
      channel_id: CHANNEL_A_ID,
      symbol: 'BTCUSDT',
      side: 'long',
      status: 'closed',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Свежее (created_at позже) действие открытия BTC — long, исполнено, есть tradeRef.
  await db
    .insertInto('actions')
    .values({
      message_id: msgA.id,
      channel_id: CHANNEL_A_ID,
      action_index: 0,
      type: 'open',
      side: 'long',
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      method: 'auto',
      status: 'executed',
      trade_id: tradeBtc.id,
      created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
    })
    .execute()

  // Закрытие той же сделки — более раннее created_at, чтобы проверить сортировку "свежие сверху".
  await db
    .insertInto('actions')
    .values({
      message_id: msgA.id,
      channel_id: CHANNEL_A_ID,
      action_index: 1,
      type: 'close',
      side: 'long',
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      method: 'auto',
      status: 'executed',
      trade_id: tradeBtc.id,
      created_at: new Date(Date.UTC(2026, 0, 1, 11, 0, 0)),
    })
    .execute()

  // Другой канал, short, без сделки (symbol ETHUSDT) — самое свежее действие.
  await db
    .insertInto('actions')
    .values({
      message_id: msgB.id,
      channel_id: CHANNEL_B_ID,
      action_index: 0,
      type: 'open',
      side: 'short',
      symbol: 'ETHUSDT',
      pair: 'ETHUSDT',
      method: 'auto',
      status: 'executed',
      created_at: new Date(Date.UTC(2026, 0, 1, 13, 0, 0)),
    })
    .execute()

  // Пропущенное действие целиком (ensureWholeMessageSkipped — pipeline.ts): side/symbol/pair null.
  await db
    .insertInto('actions')
    .values({
      message_id: msgA.id,
      channel_id: CHANNEL_A_ID,
      action_index: 2,
      type: 'open',
      side: null,
      symbol: null,
      pair: null,
      method: 'auto',
      status: 'skipped',
      skip_reason: 'no_sl',
      created_at: new Date(Date.UTC(2026, 0, 1, 10, 0, 0)),
    })
    .execute()

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /api/actions', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/actions')
    expect(res.status).toBe(401)
  })

  it('возвращает все 4 строки, свежие сверху (по created_at)', async () => {
    const res = await agent.get('/api/actions').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(4)
    // ETH open (13:00) -> BTC open (12:00) -> BTC close (11:00) -> skipped (10:00).
    expect(rows.map((r) => r.pair)).toEqual(['ETHUSDT', 'BTCUSDT', 'BTCUSDT', null])
  })

  it('строка открытия BTC несёт корректные type/side/pair/tradeRef/иконку', async () => {
    const res = await agent.get('/api/actions').expect(200)
    const rows = res.body as ActionRowDto[]
    const openBtc = rows.find((r) => r.pair === 'BTCUSDT' && r.type === 'open')!
    expect(openBtc.side).toBe('long')
    expect(openBtc.tradeRef).toBe('#TR-9001')
    expect(openBtc.channelId).toBe(CHANNEL_A_ID)
    expect(openBtc.method).toBe('auto')
    expect(openBtc.skipReason).toBeNull()
    expect(openBtc.icon).toBe('trending-up')
    expect(typeof openBtc.channelName).toBe('string')
    expect(openBtc.channelInitial).toHaveLength(1)
  })

  it('пропущенное действие отдаёт skipReason и tradeRef=null', async () => {
    const res = await agent.get('/api/actions').expect(200)
    const rows = res.body as ActionRowDto[]
    const skipped = rows.find((r) => r.skipReason !== null)!
    expect(skipped.skipReason).toBe('no_sl')
    expect(skipped.tradeRef).toBeNull()
    expect(skipped.pair).toBeNull()
  })

  it('фильтр type=open сужает список', async () => {
    const res = await agent.get('/api/actions?type=open').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(3) // ETH open + BTC open + skipped (тоже type='open')
    expect(rows.every((r) => r.type === 'open')).toBe(true)
  })

  it('фильтр side=long сужает список', async () => {
    const res = await agent.get('/api/actions?side=long').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(2) // BTC open + BTC close
    expect(rows.every((r) => r.side === 'long')).toBe(true)
  })

  it('фильтр side=short сужает список', async () => {
    const res = await agent.get('/api/actions?side=short').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pair).toBe('ETHUSDT')
  })

  it('q=BTC ищет по символу', async () => {
    const res = await agent.get('/api/actions?q=BTC').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.pair === 'BTCUSDT')).toBe(true)
  })

  it('фильтр channel сужает по каналу', async () => {
    const res = await agent.get(`/api/actions?channel=${CHANNEL_B_ID}`).expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.channelId).toBe(CHANNEL_B_ID)
  })

  it('комбинация type=close&side=long сужает до одной строки', async () => {
    const res = await agent.get('/api/actions?type=close&side=long').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pair).toBe('BTCUSDT')
    expect(rows[0]!.type).toBe('close')
  })

  // Important #2 финального ревью Ф1: GET /api/actions раньше не имел LIMIT — рос бы вечно.
  it('?limit=50 возвращает ≤50 строк (буквальная приёмка ревью)', async () => {
    const res = await agent.get('/api/actions?limit=50').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows.length).toBeLessThanOrEqual(50)
  })

  it('?limit=2 реально усекает список (4 строки в фикстуре -> 2), свежие сверху', async () => {
    const res = await agent.get('/api/actions?limit=2').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.pair)).toEqual(['ETHUSDT', 'BTCUSDT'])
  })

  it('?before=<id первой страницы> отдаёт keyset-продолжение без пересечения и без пропусков', async () => {
    const page1 = (await agent.get('/api/actions?limit=2').expect(200)).body as ActionRowDto[]
    expect(page1).toHaveLength(2)
    const cursor = page1[1]!.id

    const page2 = (await agent.get(`/api/actions?limit=2&before=${cursor}`).expect(200)).body as ActionRowDto[]
    expect(page2).toHaveLength(2)
    // BTC close (11:00) -> skipped (10:00), т.е. ровно оставшиеся 2 строки из общих 4.
    expect(page2.map((r) => r.pair)).toEqual(['BTCUSDT', null])

    const allIds = [...page1, ...page2].map((r) => r.id)
    expect(new Set(allIds).size).toBe(4) // ни одного дубля, ни одного пропуска
  })

  it('?before=<мусорный не-uuid> тихо игнорируется (не 500)', async () => {
    const res = await agent.get('/api/actions?before=not-a-uuid').expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(4) // курсор проигнорирован — как будто before не передавали вовсе
  })

  // Minor #3 финального ревью Ф1: `%`/`_` в q — LIKE-метасимволы, не экранированные до фикса
  // работали бы как wildcard. Ни у одного symbol в фикстуре нет буквального `%`/`_` — значит
  // корректно экранированный поиск обязан вернуть 0 строк, а не "все строки подряд" (баг).
  it('q="%" экранируется — не матчит все строки как LIKE-wildcard', async () => {
    const res = await agent.get(`/api/actions?q=${encodeURIComponent('%')}`).expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(0)
  })

  it('q="_" экранируется — не матчит все строки как LIKE-wildcard', async () => {
    const res = await agent.get(`/api/actions?q=${encodeURIComponent('_')}`).expect(200)
    const rows = res.body as ActionRowDto[]
    expect(rows).toHaveLength(0)
  })
})
