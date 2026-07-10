import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

// Реальные ADMIN_USERNAME/ADMIN_PASSWORD из .env (setup-env.ts грузит их наравне с DATABASE_URL) —
// это конфигурация, а не dev-данные, поэтому использовать их в e2e-тесте нормально (см. бриф).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

let app: INestApplication
let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // сидирует админа (AuthService.onModuleInit)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('POST /auth/login', () => {
  it('успешный вход ставит httpOnly-куку', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

    expect(res.status).toBe(204)
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined
    expect(cookies).toBeDefined()
    expect(cookies!.some((c) => /httponly/i.test(c))).toBe(true)
  })

  it('неверный пароль -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: ADMIN_USERNAME, password: 'definitely-wrong-password' })

    expect(res.status).toBe(401)
  })
})

describe('GET /auth/me', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me')
    expect(res.status).toBe(401)
  })

  it('с кукой отдаёт username; после logout кука очищена и /auth/me снова 401', async () => {
    const agent = request.agent(app.getHttpServer())
    await agent.post('/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)

    const me = await agent.get('/auth/me').expect(200)
    expect(me.body).toEqual({ username: ADMIN_USERNAME })

    await agent.post('/auth/logout').expect(204)

    const meAfterLogout = await agent.get('/auth/me')
    expect(meAfterLogout.status).toBe(401)
  })
})

it('сид админа идемпотентен: повторный старт не плодит пользователей и не меняет password_hash', async () => {
  const before = await db
    .selectFrom('users')
    .selectAll()
    .where('username', '=', ADMIN_USERNAME)
    .executeTakeFirstOrThrow()

  const app2 = await createApp()
  await app2.init()
  await app2.close()

  const after = await db
    .selectFrom('users')
    .selectAll()
    .where('username', '=', ADMIN_USERNAME)
    .executeTakeFirstOrThrow()

  expect(after.id).toBe(before.id)
  expect(after.password_hash).toBe(before.password_hash)

  const countRow = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('username', '=', ADMIN_USERNAME)
    .executeTakeFirstOrThrow()
  expect(Number(countRow.n)).toBe(1)
})
