import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

let app: INestApplication
let db: Kysely<DB>

beforeAll(async () => {
  // Схема сбрасывается тем же приёмом, что и в остальных e2e (auth/channels/realtime) —
  // без этого ChannelSeedService.onModuleInit() падает на UNIQUE(ord), унаследовав
  // строки, оставленные предыдущим тестовым файлом в общей тестовой БД.
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /health', () => {
  it('публичный, без куки, отвечает {status: ok} — используется docker-compose healthcheck', async () => {
    const res = await request(app.getHttpServer()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
