import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import type { ChannelDto, ChannelSettingsDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Тот же канал, что и в channels.e2e.test.ts (сидируется ChannelSeedService из общего
// CHANNEL_SOURCES) — файлы гоняются последовательно (fileParallelism:false, vitest.config.ts),
// каждый чистит схему в своём beforeAll, так что общий канал не мешает изоляции.
const CHANNEL_1_ID = Number(CHANNEL_SOURCES[0]!.channelId)

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует 2 канала (DEFAULT_CHANNEL_SETTINGS), AuthService — админа

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

it('PATCH /channels/:id/settings без куки -> 401', async () => {
  const res = await request(app.getHttpServer())
    .patch(`/api/channels/${CHANNEL_1_ID}/settings`)
    .send({ enabled: true })
  expect(res.status).toBe(401)
})

it('GET /channels/:id по умолчанию отдаёт defaultLeverage: null, crossMargin: true (DEFAULT_CHANNEL_SETTINGS)', async () => {
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}`).expect(200)
  const channel = res.body as ChannelDto
  expect(channel.defaultLeverage).toBeNull()
  expect(channel.crossMargin).toBe(true)
})

it('PATCH меняет enabled/tradeSize/maxLeverage/defaultLeverage/crossMargin и возвращает ChannelSettingsDto', async () => {
  const res = await agent
    .patch(`/api/channels/${CHANNEL_1_ID}/settings`)
    .send({ enabled: true, tradeSize: '300', maxLeverage: '5', defaultLeverage: '3', crossMargin: false })
    .expect(200)
  const settings = res.body as ChannelSettingsDto
  expect(settings.channelId).toBe(CHANNEL_1_ID)
  expect(settings.enabled).toBe(true)
  expect(settings.tradeSize).toBe('$300')
  expect(settings.maxLeverage).toBe('5x')
  expect(settings.defaultLeverage).toBe('3x')
  expect(settings.crossMargin).toBe(false)

  // GET /channels/:id отдаёт то же самое, что реально было записано в channel_settings.
  const getRes = await agent.get(`/api/channels/${CHANNEL_1_ID}`).expect(200)
  const channel = getRes.body as ChannelDto
  expect(channel.copyEnabled).toBe(true)
  expect(channel.tradeSize).toBe('$300')
  expect(channel.maxLeverage).toBe('5x')
  expect(channel.defaultLeverage).toBe('3x')
  expect(channel.crossMargin).toBe(false)
})

it('PATCH — частичное обновление одного поля не трогает остальные', async () => {
  const res = await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: '750' }).expect(200)
  const settings = res.body as ChannelSettingsDto
  expect(settings.tradeSize).toBe('$750')
  // Значения из предыдущего теста сохранились — patch не сбросил их дефолтами.
  expect(settings.maxLeverage).toBe('5x')
  expect(settings.enabled).toBe(true)
  expect(settings.crossMargin).toBe(false)
})

it('PATCH defaultLeverage: null очищает поле (не путать с "не передано")', async () => {
  const res = await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ defaultLeverage: null }).expect(200)
  expect((res.body as ChannelSettingsDto).defaultLeverage).toBeNull()
})

it('tradeSize <= 0 -> 400', async () => {
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: '0' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: '-10' }).expect(400)
})

it('maxLeverage < 1 -> 400', async () => {
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ maxLeverage: '0' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ maxLeverage: '0.5' }).expect(400)
})

it('defaultLeverage не-null и < 1 -> 400', async () => {
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ defaultLeverage: '0' }).expect(400)
})

// Адверсариал-ревью M1: значения, которые Number() «понимает», но NUMERIC-колонка отвергает,
// должны давать 400 (валидатор), а не 500 (ошибка Postgres при записи мусора/переполнении).
it('нечисловой мусор, hex и экспонента -> 400 (не 500)', async () => {
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: '0x10' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: '1e3' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: 'abc' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ tradeSize: ' 5 ' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ maxLeverage: '0x0A' }).expect(400)
})

it('maxLeverage сверх диапазона колонки NUMERIC(6,2) -> 400 (не numeric overflow / 500)', async () => {
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ maxLeverage: '100000' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ maxLeverage: '126' }).expect(400)
  await agent.patch(`/api/channels/${CHANNEL_1_ID}/settings`).send({ defaultLeverage: '100000' }).expect(400)
})

it('неизвестный канал -> 404', async () => {
  await agent.patch('/api/channels/999999/settings').send({ enabled: true }).expect(404)
})
