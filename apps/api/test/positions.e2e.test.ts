import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { PositionDto, PositionStatsDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

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

  const tradeBtc = await db
    .insertInto('trades')
    .values({ human_ref: 'TR-9101', seq: 9101, channel_id: CHANNEL_A_ID, symbol: 'BTCUSDT', side: 'long', status: 'open' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const tradeEth = await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-9102',
      seq: 9102,
      channel_id: CHANNEL_A_ID,
      symbol: 'ETHUSDT',
      side: 'short',
      status: 'open',
      margin_mode: 'isolated',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const tradeSol = await db
    .insertInto('trades')
    .values({ human_ref: 'TR-9103', seq: 9103, channel_id: CHANNEL_B_ID, symbol: 'SOLUSDT', side: 'long', status: 'closed' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const tradeXrp = await db
    .insertInto('trades')
    .values({ human_ref: 'TR-9104', seq: 9104, channel_id: CHANNEL_B_ID, symbol: 'XRPUSDT', side: 'long', status: 'open' })
    .returning('id')
    .executeTakeFirstOrThrow()

  // BTC (channel A, long, cross) — с реальным unrealised_pnl/position_im, чтобы проверить roi.
  await db
    .insertInto('positions')
    .values({
      channel_id: CHANNEL_A_ID,
      symbol: 'BTCUSDT',
      trade_id: tradeBtc.id,
      side: 'long',
      size: '0.5',
      avg_price: '60000',
      mark_price: '61000',
      liq_price: '55000',
      leverage: '10',
      unrealised_pnl: '500.00',
      position_im: '3000.00',
      take_profit: '65000',
      stop_loss: '58000',
    })
    .execute()

  // ETH (channel A, short, isolated) — unrealised_pnl/position_im не заданы (Ф1: нет тикер-фида).
  await db
    .insertInto('positions')
    .values({
      channel_id: CHANNEL_A_ID,
      symbol: 'ETHUSDT',
      trade_id: tradeEth.id,
      side: 'short',
      size: '3',
      avg_price: '3000',
      mark_price: '2900',
      leverage: '5',
    })
    .execute()

  // SOL (channel B) — позиция закрыта (size=0): не должна попасть ни в список, ни в статистику.
  await db
    .insertInto('positions')
    .values({
      channel_id: CHANNEL_B_ID,
      symbol: 'SOLUSDT',
      trade_id: tradeSol.id,
      side: 'long',
      size: '0',
      avg_price: '148',
      mark_price: '148',
      leverage: '5',
    })
    .execute()

  // XRP (channel B, long, cross по умолчанию).
  await db
    .insertInto('positions')
    .values({
      channel_id: CHANNEL_B_ID,
      symbol: 'XRPUSDT',
      trade_id: tradeXrp.id,
      side: 'long',
      size: '10',
      avg_price: '2',
      mark_price: '2',
      leverage: '1',
    })
    .execute()

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /api/positions', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/positions')
    expect(res.status).toBe(401)
  })

  it('отдаёт только позиции с size<>0 (SOL с size=0 исключена)', async () => {
    const res = await agent.get('/api/positions').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(3)
    expect(rows.some((p) => p.symbol === 'SOLUSDT')).toBe(false)
  })

  it('строка BTC несёт корректные size/entry/mark/liq/tp/sl/leverage/marginMode/tradeRef/roi', async () => {
    const res = await agent.get('/api/positions').expect(200)
    const rows = res.body as PositionDto[]
    const btc = rows.find((p) => p.symbol === 'BTCUSDT')!
    expect(btc.side).toBe('long')
    expect(btc.size).toBe('0.5')
    expect(btc.entry).toBe('60000')
    expect(btc.mark).toBe('61000')
    expect(btc.liq).toBe('55000')
    expect(btc.tp).toBe('65000')
    expect(btc.sl).toBe('58000')
    expect(btc.leverage).toBe('10x')
    expect(btc.marginMode).toBe('Cross')
    expect(btc.tradeRef).toBe('#TR-9101')
    expect(btc.channelId).toBe(CHANNEL_A_ID)
    expect(btc.unrealisedPnl).toBe('+$500.00')
    expect(btc.roi).toBe('+16.7%')
  })

  it('позиция без unrealised_pnl/position_im (Ф1, нет тикер-фида) — pnl 0, roi 0%, а не NaN/null', async () => {
    const res = await agent.get('/api/positions').expect(200)
    const rows = res.body as PositionDto[]
    const eth = rows.find((p) => p.symbol === 'ETHUSDT')!
    expect(eth.unrealisedPnl).toBe('+$0.00')
    expect(eth.roi).toBe('+0.0%')
    expect(eth.marginMode).toBe('Isolated')
    expect(eth.tp).toBeNull()
    expect(eth.sl).toBeNull()
    expect(eth.liq).toBeNull()
  })

  it('фильтр side=short сужает список', async () => {
    const res = await agent.get('/api/positions?side=short').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.symbol).toBe('ETHUSDT')
  })

  it('фильтр margin=isolated сужает список', async () => {
    const res = await agent.get('/api/positions?margin=isolated').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.symbol).toBe('ETHUSDT')
  })

  it('фильтр channel сужает по каналу', async () => {
    const res = await agent.get(`/api/positions?channel=${CHANNEL_B_ID}`).expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.symbol).toBe('XRPUSDT')
  })

  it('q ищет по символу', async () => {
    const res = await agent.get('/api/positions?q=BTC').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.symbol).toBe('BTCUSDT')
  })

  it('q ищет по #TR-номеру сделки', async () => {
    const res = await agent.get('/api/positions?q=9104').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.symbol).toBe('XRPUSDT')
  })

  // Minor #3 финального ревью Ф1: `%`/`_` в q — LIKE-метасимволы, не экранированные до фикса
  // работали бы как wildcard, т.е. матчили бы ВСЕ 3 открытые позиции сразу (баг). Ни в одном
  // symbol/channel-key/human_ref фикстуры нет буквального `%`/`_` — корректно экранированный
  // поиск обязан вернуть 0 строк.
  it('q="%" экранируется — не матчит все позиции как LIKE-wildcard', async () => {
    const res = await agent.get(`/api/positions?q=${encodeURIComponent('%')}`).expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(0)
  })

  it('q="_" экранируется — не матчит все позиции как LIKE-wildcard', async () => {
    const res = await agent.get(`/api/positions?q=${encodeURIComponent('_')}`).expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(0)
  })
})

describe('GET /api/positions/stats', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/positions/stats')
    expect(res.status).toBe(401)
  })

  it('считает агрегаты только по открытым позициям (SOL с size=0 не учтена)', async () => {
    const res = await agent.get('/api/positions/stats').expect(200)
    const stats = res.body as PositionStatsDto
    expect(stats.openPositions).toBe(3)
    expect(stats.unrealisedPnl).toBe('+$500.00')
    expect(stats.positionValue).toBe('$39,220')
    expect(stats.marginUsed).toBe('$4,760')
  })
})
