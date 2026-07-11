import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { PendingOrderDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Те же 2 канала, что сидирует ChannelSeedService при старте приложения (CHANNEL_SOURCES) —
// тот же приём, что и actions.e2e.test.ts/positions.e2e.test.ts.
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
  await app.init() // ChannelSeedService сидирует 2 канала + channel_settings (limit_ttl_sec=604800), AuthService — админа

  const msgA = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_A_ID,
      tg_message_id: 7001,
      is_topic_message: false,
      text: '#BTC/USDT Long\nEntry 60000',
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
      tg_message_id: 8001,
      is_topic_message: false,
      text: 'ETH/USDT add',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 0, 1, 12, 5, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const actionA = await db
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
      status: 'executing',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const actionB = await db
    .insertInto('actions')
    .values({
      message_id: msgB.id,
      channel_id: CHANNEL_B_ID,
      action_index: 0,
      type: 'add',
      side: 'short',
      symbol: 'ETHUSDT',
      pair: 'ETHUSDT',
      method: 'auto',
      status: 'executing',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const tradeBtc = await db
    .insertInto('trades')
    .values({ human_ref: 'TR-9201', seq: 9201, channel_id: CHANNEL_A_ID, symbol: 'BTCUSDT', side: 'long', status: 'pending' })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Один multi-row insert вместо 7 отдельных round-trip'ов — beforeAll этого файла и так делает
  // больше похода к БД, чем соседние e2e (2 сообщения + 2 действия + 1 сделка выше), пакетная
  // вставка держит его в бюджете дефолтного hookTimeout (10с) на разделяемой машине.
  await db
    .insertInto('orders')
    .values([
      // XRP (channel B, entry, БЕЗ сделки) — самый близкий explicit TTL (2026-01-01T12:00:00Z) —
      // должен оказаться ПЕРВЫМ в отсортированном списке (скоро истекающие сверху).
      {
        trade_id: null,
        action_id: actionB.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'XRPUSDT',
        order_link_id: 'test-pending-xrp-entry',
        purpose: 'entry',
        side: 'long',
        order_type: 'limit',
        reduce_only: false,
        qty: '100.5',
        price: '2.3456',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 11, 59, 0)),
        created_at: new Date(Date.UTC(2026, 0, 1, 11, 0, 0)),
        ttl_expires_at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
      },
      // BTC (channel A, entry, со сделкой) — explicit TTL (2026-01-02T00:00:00Z) — второй по сроку.
      {
        trade_id: tradeBtc.id,
        action_id: actionA.id,
        channel_id: CHANNEL_A_ID,
        symbol: 'BTCUSDT',
        order_link_id: 'test-pending-btc-entry',
        purpose: 'entry',
        side: 'long',
        order_type: 'limit',
        reduce_only: false,
        qty: '0.5',
        price: '60000',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 12, 0, 1)),
        created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
        ttl_expires_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0)),
      },
      // ETH (channel B, add, БЕЗ явного ttl_expires_at) — эффективный TTL считается как fallback
      // created_at + channel_settings.limit_ttl_sec (604800с = 7 дней от 2026-01-01T00:00:00Z =
      // 2026-01-08T00:00:00Z) — самый дальний срок, третий (последний) в сортировке.
      {
        trade_id: null,
        action_id: actionB.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'ETHUSDT',
        order_link_id: 'test-pending-eth-add',
        purpose: 'add',
        side: 'short',
        order_type: 'limit',
        reduce_only: false,
        qty: '3',
        price: '3000',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)),
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        ttl_expires_at: null,
      },
      // Уже исполненная лимитка (status='filled') — НЕ должна попасть в pending.
      {
        trade_id: tradeBtc.id,
        action_id: actionA.id,
        channel_id: CHANNEL_A_ID,
        symbol: 'BTCUSDT',
        order_link_id: 'test-pending-filled',
        purpose: 'entry',
        side: 'long',
        order_type: 'limit',
        reduce_only: false,
        qty: '1',
        price: '59000',
        status: 'filled',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 10, 0, 0)),
        filled_at: new Date(Date.UTC(2026, 0, 1, 10, 5, 0)),
      },
      // Отменённая лимитка (status='cancelled') — НЕ должна попасть в pending.
      {
        trade_id: null,
        action_id: actionB.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'ETHUSDT',
        order_link_id: 'test-pending-cancelled',
        purpose: 'entry',
        side: 'short',
        order_type: 'limit',
        reduce_only: false,
        qty: '2',
        price: '3100',
        status: 'cancelled',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 9, 0, 0)),
        cancelled_at: new Date(Date.UTC(2026, 0, 1, 9, 30, 0)),
      },
      // TP (reduce_only=true, submitted, БЕЗ ttl) — протектор уже открытой позиции, НЕ "отложенная
      // лимитка на вход" (design spec §9) — НЕ должен попасть в pending, несмотря на
      // status='submitted' AND order_type='limit'.
      {
        trade_id: tradeBtc.id,
        action_id: actionA.id,
        channel_id: CHANNEL_A_ID,
        symbol: 'BTCUSDT',
        order_link_id: 'test-pending-tp',
        purpose: 'tp',
        side: 'short',
        order_type: 'limit',
        reduce_only: true,
        qty: '0.5',
        price: '65000',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 12, 1, 0)),
      },
      // SL (reduce_only=true, submitted, БЕЗ ttl) — тот же случай, что и TP выше.
      {
        trade_id: tradeBtc.id,
        action_id: actionA.id,
        channel_id: CHANNEL_A_ID,
        symbol: 'BTCUSDT',
        order_link_id: 'test-pending-sl',
        purpose: 'sl',
        side: 'short',
        order_type: 'limit',
        reduce_only: true,
        qty: '0.5',
        price: '58000',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 12, 1, 0)),
      },
      // Market-ордер на вход, submitted, reduce_only=false, purpose='entry' — в реальности market
      // исполняется немедленно (dry-run проставляет 'filled' на market атомарно с постановкой), но
      // условие order_type='limit' должно исключать его и как защитный случай само по себе.
      {
        trade_id: null,
        action_id: actionB.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'SOLUSDT',
        order_link_id: 'test-pending-market',
        purpose: 'entry',
        side: 'long',
        order_type: 'market',
        reduce_only: false,
        qty: '10',
        price: '150',
        status: 'submitted',
        submitted_at: new Date(Date.UTC(2026, 0, 1, 12, 2, 0)),
      },
    ])
    .execute()

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
  // Явный timeout (дефолт vitest — 10с): beforeAll этого файла делает больше round-trip'ов к БД,
  // чем соседние e2e (2 сообщения + 2 действия + 1 сделка + один multi-row insert на 8 ордеров +
  // app.init()), и на разделяемой машине (см. ограничения задачи — "чужая нагрузка") это иногда
  // выходит за дефолтный бюджет даже после батчинга ордеров в один insert.
}, 30_000)

afterAll(async () => {
  await app.close()
  await db.destroy()
})

describe('GET /api/orders/pending', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/orders/pending')
    expect(res.status).toBe(401)
  })

  it('отдаёт только submitted limit entry/add с reduce_only=false (3 строки)', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    expect(rows).toHaveLength(3)
    const linkIds = rows.map((r) => r.orderLinkId).sort()
    expect(linkIds).toEqual(['test-pending-btc-entry', 'test-pending-eth-add', 'test-pending-xrp-entry'])
  })

  it('filled/cancelled/tp/sl/market НЕ попадают в ответ', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    const excluded = [
      'test-pending-filled',
      'test-pending-cancelled',
      'test-pending-tp',
      'test-pending-sl',
      'test-pending-market',
    ]
    for (const linkId of excluded) {
      expect(rows.some((r) => r.orderLinkId === linkId)).toBe(false)
    }
  })

  it('строка BTC несёт корректные поля (money/qty строками, channelTitle, tradeRef)', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    const btc = rows.find((r) => r.orderLinkId === 'test-pending-btc-entry')!
    expect(btc.symbol).toBe('BTCUSDT')
    expect(btc.side).toBe('long')
    expect(btc.purpose).toBe('entry')
    expect(btc.price).toBe('60000')
    expect(btc.qty).toBe('0.5')
    expect(typeof btc.price).toBe('string')
    expect(typeof btc.qty).toBe('string')
    expect(btc.channelId).toBe(CHANNEL_A_ID)
    expect(btc.tradeRef).toBe('#TR-9201')
    expect(btc.ttlExpiresAt).toBe(new Date(Date.UTC(2026, 0, 2, 0, 0, 0)).toISOString())
  })

  it('строка XRP без сделки — tradeRef null', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    const xrp = rows.find((r) => r.orderLinkId === 'test-pending-xrp-entry')!
    expect(xrp.tradeRef).toBeNull()
    expect(xrp.purpose).toBe('entry')
  })

  it('строка ETH (add, без явного ttl_expires_at) — эффективный TTL = created_at + limit_ttl_sec (604800с)', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    const eth = rows.find((r) => r.orderLinkId === 'test-pending-eth-add')!
    expect(eth.purpose).toBe('add')
    const expected = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + 604_800 * 1000).toISOString()
    expect(eth.ttlExpiresAt).toBe(expected)
  })

  it('сортировка по ttlExpiresAt ASC — XRP (скорее всего истечёт), затем BTC, затем ETH', async () => {
    const res = await agent.get('/api/orders/pending').expect(200)
    const rows = res.body as PendingOrderDto[]
    expect(rows.map((r) => r.orderLinkId)).toEqual([
      'test-pending-xrp-entry',
      'test-pending-btc-entry',
      'test-pending-eth-add',
    ])
  })
})
