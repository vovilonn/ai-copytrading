import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { sql, type Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { AiModelMetricsDto, MetricsDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Тот же приём, что и actions.e2e.test.ts/orders-pending.e2e.test.ts — 2 канала, засеянных
// ChannelSeedService при app.init().
const CHANNEL_A_ID = Number(CHANNEL_SOURCES[0]!.channelId)

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует 2 канала, AuthService — админа

  // --- ai_calls: 2 модели, разные cache_hit/escalated/latency/cost/error --------------------
  // model-a: 4 вызова, latency [100,200,300,400] -> percentile_cont(0.5)=250, (0.95)=385, avg=250.
  // cache_hit: 3 из 4 (true,true,true,false) -> cacheHitRate=0.75. 1 эскалация. cost 0.01+0.02+0.03+0.04=0.10.
  // ai_calls НЕ типизирована в Kysely DB (apps/api/src/db/database.ts:314) — db.insertInto('ai_calls')
  // не скомпилируется, вставляем сырым sql`...` (тот же приём, что и чтение в metrics.service.ts).
  const aiCallFixtures = [
    { model: 'model-a', hash: 'hash-a-1', in: 100, cacheRead: 10, out: 50, cost: '0.01', latency: 100, status: 200, attempt: 1, cacheHit: true, escalated: false, error: null },
    { model: 'model-a', hash: 'hash-a-2', in: 200, cacheRead: 20, out: 60, cost: '0.02', latency: 200, status: 200, attempt: 1, cacheHit: true, escalated: false, error: null },
    { model: 'model-a', hash: 'hash-a-3', in: 300, cacheRead: 30, out: 70, cost: '0.03', latency: 300, status: 200, attempt: 1, cacheHit: true, escalated: true, error: null },
    { model: 'model-a', hash: 'hash-a-4', in: 400, cacheRead: 40, out: 80, cost: '0.04', latency: 400, status: 200, attempt: 1, cacheHit: false, escalated: false, error: null },
    // model-b: 2 вызова, оба cache_hit=false, latency [500,600] -> p50=550, p95=595, avg=550.
    // cost 0.05+0.15=0.20. Второй — с ошибкой (error IS NOT NULL) для проверки errors-счётчика.
    { model: 'model-b', hash: 'hash-b-1', in: 500, cacheRead: 0, out: 90, cost: '0.05', latency: 500, status: 200, attempt: 1, cacheHit: false, escalated: false, error: null },
    { model: 'model-b', hash: 'hash-b-2', in: 600, cacheRead: 0, out: 100, cost: '0.15', latency: 600, status: 500, attempt: 2, cacheHit: false, escalated: false, error: 'upstream 500' },
  ]
  await sql`
    INSERT INTO ai_calls
      (model, prompt_version, request_hash, input_tokens, cache_creation_input_tokens,
       cache_read_input_tokens, output_tokens, cost_usd, latency_ms, http_status, attempt,
       cache_hit, escalated, error)
    VALUES ${sql.join(
      aiCallFixtures.map(
        (c) =>
          sql`(${c.model}, 'v1', ${c.hash}, ${c.in}, 0, ${c.cacheRead}, ${c.out}, ${c.cost}, ${c.latency}, ${c.status}, ${c.attempt}, ${c.cacheHit}, ${c.escalated}, ${c.error})`,
      ),
    )}
  `.execute(db)

  // --- actions: 3 executed, 4 с skip_reason (2 skipped + 1 skipped + 1 needs_review) --------
  const msg = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_A_ID,
      tg_message_id: 9101,
      is_topic_message: false,
      text: 'metrics fixture',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db
    .insertInto('actions')
    .values([
      { message_id: msg.id, channel_id: CHANNEL_A_ID, action_index: 0, type: 'open', method: 'auto', status: 'executed' },
      { message_id: msg.id, channel_id: CHANNEL_A_ID, action_index: 1, type: 'close', method: 'auto', status: 'executed' },
      { message_id: msg.id, channel_id: CHANNEL_A_ID, action_index: 2, type: 'add', method: 'auto', status: 'executed' },
      {
        message_id: msg.id,
        channel_id: CHANNEL_A_ID,
        action_index: 3,
        type: 'open',
        method: 'auto',
        status: 'skipped',
        skip_reason: 'no_open_position',
      },
      {
        message_id: msg.id,
        channel_id: CHANNEL_A_ID,
        action_index: 4,
        type: 'open',
        method: 'auto',
        status: 'skipped',
        skip_reason: 'no_open_position',
      },
      {
        message_id: msg.id,
        channel_id: CHANNEL_A_ID,
        action_index: 5,
        type: 'open',
        method: 'auto',
        status: 'skipped',
        skip_reason: 'symbol_not_listed',
      },
      // needs_review — тоже несёт skip_reason, но status != 'skipped' (реальные данные ai_unavailable
      // и т.п., см. бриф). bySkipReason обязан учитывать И такие строки — операторская сводка
      // "что и почему AI-слой не исполнил", а не только формально status='skipped'.
      {
        message_id: msg.id,
        channel_id: CHANNEL_A_ID,
        action_index: 6,
        type: 'open',
        method: 'ai',
        status: 'needs_review',
        skip_reason: 'ai_unavailable',
      },
    ])
    .execute()

  // --- trades: 2 open, 2 closed (1 win, 1 loss), 1 cancelled -> winRate = 50% ----------------
  await db
    .insertInto('trades')
    .values([
      { human_ref: 'TR-M001', seq: 90001, channel_id: CHANNEL_A_ID, symbol: 'BTCUSDT', side: 'long', status: 'open' },
      { human_ref: 'TR-M002', seq: 90002, channel_id: CHANNEL_A_ID, symbol: 'ETHUSDT', side: 'short', status: 'open' },
      {
        human_ref: 'TR-M003',
        seq: 90003,
        channel_id: CHANNEL_A_ID,
        symbol: 'SOLUSDT',
        side: 'long',
        status: 'closed',
        is_win: true,
      },
      {
        human_ref: 'TR-M004',
        seq: 90004,
        channel_id: CHANNEL_A_ID,
        symbol: 'XRPUSDT',
        side: 'short',
        status: 'closed',
        is_win: false,
      },
      { human_ref: 'TR-M005', seq: 90005, channel_id: CHANNEL_A_ID, symbol: 'ADAUSDT', side: 'long', status: 'cancelled' },
    ])
    .execute()

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
}, 30_000)

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /api/metrics/ai', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/metrics/ai')
    expect(res.status).toBe(401)
  })

  it('ai.totalCalls/totalCostUsd/cacheHitRate/errors агрегируют обе модели', async () => {
    const res = await agent.get('/api/metrics/ai').expect(200)
    const body = res.body as MetricsDto
    expect(body.ai.totalCalls).toBe(6)
    expect(body.ai.totalCostUsd).toBe('$0.3')
    expect(body.ai.cacheHitRate).toBeCloseTo(0.5, 5)
    expect(body.ai.errors).toBe(1)
  })

  it('ai.byModel несёт 2 модели, отсортированные по имени, с корректными агрегатами', async () => {
    const res = await agent.get('/api/metrics/ai').expect(200)
    const body = res.body as MetricsDto
    expect(body.ai.byModel).toHaveLength(2)
    expect(body.ai.byModel.map((m) => m.model)).toEqual(['model-a', 'model-b'])

    const a = body.ai.byModel.find((m) => m.model === 'model-a')! as AiModelMetricsDto
    expect(a.calls).toBe(4)
    expect(a.cacheHitRate).toBeCloseTo(0.75, 5)
    expect(a.escalations).toBe(1)
    expect(a.avgLatencyMs).toBe(250)
    expect(a.p50LatencyMs).toBe(250)
    expect(a.p95LatencyMs).toBe(385)
    expect(a.totalCostUsd).toBe('$0.1')
    expect(a.inputTokens).toBe(1000)
    expect(a.cacheReadTokens).toBe(100)
    expect(a.outputTokens).toBe(260)

    const b = body.ai.byModel.find((m) => m.model === 'model-b')!
    expect(b.calls).toBe(2)
    expect(b.cacheHitRate).toBe(0)
    expect(b.escalations).toBe(0)
    expect(b.avgLatencyMs).toBe(550)
    expect(b.p50LatencyMs).toBe(550)
    expect(b.p95LatencyMs).toBe(595)
    expect(b.totalCostUsd).toBe('$0.2')
  })

  it('actions.total/executed/skipped/bySkipReason учитывают skipped И needs_review со skip_reason', async () => {
    const res = await agent.get('/api/metrics/ai').expect(200)
    const body = res.body as MetricsDto
    expect(body.actions.total).toBe(7)
    expect(body.actions.executed).toBe(3)
    expect(body.actions.skipped).toBe(4)
    expect(body.actions.bySkipReason).toEqual({
      no_open_position: 2,
      symbol_not_listed: 1,
      ai_unavailable: 1,
    })
  })

  it('trades.open/closed/cancelled/winRate по всем каналам', async () => {
    const res = await agent.get('/api/metrics/ai').expect(200)
    const body = res.body as MetricsDto
    expect(body.trades.open).toBe(2)
    expect(body.trades.closed).toBe(2)
    expect(body.trades.cancelled).toBe(1)
    expect(body.trades.winRate).toBe('50%')
  })
})
