import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { AccountWalletDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

const CHANNEL_A_ID = Number(CHANNEL_SOURCES[0]!.channelId)

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует каналы, AuthService — админа

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /api/account/wallet', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/account/wallet')
    expect(res.status).toBe(401)
  })

  it('снапшотов нет -> equity/available "$0.00", asOf null, perChannel []', async () => {
    const res = await agent.get('/api/account/wallet').expect(200)
    const wallet = res.body as AccountWalletDto
    expect(wallet.totalEquity).toBe('$0.00')
    expect(wallet.availableBalance).toBe('$0.00')
    expect(wallet.currency).toBe('USDT')
    expect(wallet.asOf).toBeNull()
    expect(wallet.perChannel).toEqual([]) // ни открытых позиций, ни закрытых сделок
  })

  it('отдаёт последний account-level снапшот (channel_id IS NULL) и per-channel PnL', async () => {
    // Более старый снапшот — не должен победить.
    await db
      .insertInto('wallet_snapshots')
      .values({
        channel_id: null,
        total_equity: '9000',
        available_balance: '8000',
        currency: 'USDT',
        created_at: new Date(Date.UTC(2026, 6, 1, 0, 0, 0)),
      })
      .execute()
    // Снапшот уровня канала (channel_id != null) — НЕ account-level, должен игнорироваться.
    await db
      .insertInto('wallet_snapshots')
      .values({
        channel_id: CHANNEL_A_ID,
        total_equity: '999999',
        available_balance: '999999',
        currency: 'USDT',
        created_at: new Date(Date.UTC(2026, 6, 12, 0, 0, 0)),
      })
      .execute()
    // Самый свежий account-level — его и ждём.
    await db
      .insertInto('wallet_snapshots')
      .values({
        channel_id: null,
        total_equity: '12345.6789',
        available_balance: '10000.5',
        currency: 'USDT',
        created_at: new Date(Date.UTC(2026, 6, 11, 12, 0, 0)),
      })
      .execute()

    const res = await agent.get('/api/account/wallet').expect(200)
    const wallet = res.body as AccountWalletDto
    expect(wallet.totalEquity).toBe('$12,345.68') // округление money до 2 знаков
    expect(wallet.availableBalance).toBe('$10,000.50')
    expect(wallet.currency).toBe('USDT')
    expect(wallet.asOf).toBe(new Date(Date.UTC(2026, 6, 11, 12, 0, 0)).toISOString())
    expect(Array.isArray(wallet.perChannel)).toBe(true)
  })
})
