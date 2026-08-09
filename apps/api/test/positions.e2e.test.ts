import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Kysely } from 'kysely'
import type { INestApplication } from '@nestjs/common'
import { resetTestSchema } from 'test-db'
import type { ChannelPnlDto, ClosedTradeDto, PositionDto, PositionStatsDto } from 'shared/dto.js'
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

  // XRP (channel B, long, cross по умолчанию). TP выставлен ЛЕСЕНКОЙ reduce-only лимиток — так это
  // и делает engine (positions.take_profit при этом пуст, см. тест про TP-лесенку ниже).
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

  const xrpMsg = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_B_ID,
      tg_message_id: 9104,
      is_topic_message: false,
      text: 'xrp tp ladder seed',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 6, 10, 8, 0, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const xrpAction = await db
    .insertInto('actions')
    .values({
      message_id: xrpMsg.id,
      channel_id: CHANNEL_B_ID,
      action_index: 0,
      type: 'open',
      side: 'long',
      symbol: 'XRPUSDT',
      pair: 'XRPUSDT',
      method: 'auto',
      status: 'executed',
      trade_id: tradeXrp.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db
    .insertInto('orders')
    .values([
      // Две активные цели — попадают в лесенку (ближайшая для long = меньшая цена).
      {
        action_id: xrpAction.id,
        trade_id: tradeXrp.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'XRPUSDT',
        order_link_id: 'CT-9104-tp2',
        purpose: 'tp',
        side: 'long',
        order_type: 'limit',
        reduce_only: true,
        price: '0.68',
        status: 'submitted',
      },
      {
        action_id: xrpAction.id,
        trade_id: tradeXrp.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'XRPUSDT',
        order_link_id: 'CT-9104-tp1',
        purpose: 'tp',
        side: 'long',
        order_type: 'limit',
        reduce_only: true,
        price: '0.62',
        status: 'submitted',
      },
      // Уже сработавшая цель — в лесенке её быть не должно (она больше не защищает позицию).
      {
        action_id: xrpAction.id,
        trade_id: tradeXrp.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'XRPUSDT',
        order_link_id: 'CT-9104-tp0',
        purpose: 'tp',
        side: 'long',
        order_type: 'limit',
        reduce_only: true,
        price: '0.55',
        status: 'filled',
      },
      // Ордер на ВХОД той же сделки — не TP, в лесенку не попадает.
      {
        action_id: xrpAction.id,
        trade_id: tradeXrp.id,
        channel_id: CHANNEL_B_ID,
        symbol: 'XRPUSDT',
        order_link_id: 'CT-9104-entry',
        purpose: 'entry',
        side: 'long',
        order_type: 'limit',
        reduce_only: false,
        price: '0.50',
        status: 'submitted',
      },
    ])
    .execute()

  // Деньги, которые прежний фильтр status='closed' терял: комиссия входа по ОТКРЫТОЙ сделке
  // (биржа списала её уже сейчас) и результат ЧАСТИЧНО закрытой (статус не подходил под фильтр).
  await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-9105',
      seq: 9105,
      channel_id: CHANNEL_A_ID,
      symbol: 'ARBUSDT',
      side: 'long',
      status: 'open',
      realized_pnl: '-0.25', // комиссия входа
    })
    .execute()
  await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-9106',
      seq: 9106,
      channel_id: CHANNEL_B_ID,
      symbol: 'INJUSDT',
      side: 'long',
      status: 'partially_closed',
      realized_pnl: '20.00', // зафиксированная часть
    })
    .execute()

  // --- Task 2: закрытые/отменённые сделки для /history, расширенной stats и by-channel ---
  const seedMsg = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_A_ID,
      tg_message_id: 7000,
      is_topic_message: false,
      text: 'closed-trades seed',
      has_media: false,
      msg_ts: new Date(Date.UTC(2026, 6, 10, 8, 0, 0)),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // TR-7001 (channel A, BTC long, closed, WIN): tp_hit-action -> closeReason 'tp';
  // два reduce-only исполнения -> exitPrice = взвеш. средняя (61000·0.3 + 61500·0.2)/0.5 = 61200.
  const tr7001 = await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-7001',
      seq: 7001,
      channel_id: CHANNEL_A_ID,
      symbol: 'BTCUSDT',
      side: 'long',
      status: 'closed',
      avg_entry: '60000',
      realized_pnl: '150.50',
      is_win: true,
      leverage: '10',
      opened_at: new Date(Date.UTC(2026, 6, 11, 9, 0, 0)),
      closed_at: new Date(Date.UTC(2026, 6, 11, 10, 0, 0)),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const act7001 = await db
    .insertInto('actions')
    .values({
      message_id: seedMsg.id,
      channel_id: CHANNEL_A_ID,
      action_index: 10,
      type: 'tp_hit',
      side: 'long',
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      method: 'auto',
      status: 'executed',
      trade_id: tr7001.id,
      created_at: new Date(Date.UTC(2026, 6, 11, 10, 0, 0)),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const ord7001 = await db
    .insertInto('orders')
    .values({
      action_id: act7001.id,
      trade_id: tr7001.id,
      channel_id: CHANNEL_A_ID,
      symbol: 'BTCUSDT',
      order_link_id: 'CT-7001-close',
      purpose: 'close',
      side: 'short',
      order_type: 'market',
      reduce_only: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('executions')
    .values([
      {
        order_id: ord7001.id,
        trade_id: tr7001.id,
        bybit_exec_id: 'EX-7001-a',
        symbol: 'BTCUSDT',
        side: 'short',
        exec_qty: '0.3',
        exec_price: '61000',
        exec_ts: new Date(Date.UTC(2026, 6, 11, 10, 0, 0)),
      },
      {
        order_id: ord7001.id,
        trade_id: tr7001.id,
        bybit_exec_id: 'EX-7001-b',
        symbol: 'BTCUSDT',
        side: 'short',
        exec_qty: '0.2',
        exec_price: '61500',
        exec_ts: new Date(Date.UTC(2026, 6, 11, 10, 0, 1)),
      },
    ])
    .execute()

  // TR-7002 (channel A, ETH short, closed, LOSS): sl_hit-action -> closeReason 'sl';
  // исполнений нет -> exitPrice null (dry-run-хвост).
  const tr7002 = await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-7002',
      seq: 7002,
      channel_id: CHANNEL_A_ID,
      symbol: 'ETHUSDT',
      side: 'short',
      status: 'closed',
      avg_entry: '3000',
      realized_pnl: '-40.25',
      is_win: false,
      leverage: '5',
      opened_at: new Date(Date.UTC(2026, 6, 10, 8, 0, 0)),
      closed_at: new Date(Date.UTC(2026, 6, 10, 10, 0, 0)),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('actions')
    .values({
      message_id: seedMsg.id,
      channel_id: CHANNEL_A_ID,
      action_index: 11,
      type: 'sl_hit',
      side: 'short',
      symbol: 'ETHUSDT',
      pair: 'ETHUSDT',
      method: 'auto',
      status: 'executed',
      trade_id: tr7002.id,
      created_at: new Date(Date.UTC(2026, 6, 10, 10, 0, 0)),
    })
    .execute()

  // TR-7003 (channel A, SOL long, CANCELLED без closed_at/opened_at) — отменённая лимитка:
  // closeReason 'cancelled', durationMs 0, avgEntry '0'. Исключена из status=closed и из realized.
  await db
    .insertInto('trades')
    .values({
      human_ref: 'TR-7003',
      seq: 7003,
      channel_id: CHANNEL_A_ID,
      symbol: 'SOLUSDT',
      side: 'long',
      status: 'cancelled',
      avg_entry: null,
      realized_pnl: '0',
      leverage: '3',
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

  // Регрессия: engine выставляет TP отдельными reduce-only ЛИМИТ-ордерами, а не trading-stop'ом
  // позиции, поэтому positions.take_profit почти всегда пуст. Раньше карточка показывала «TP —» при
  // реально висящих на бирже целях, а в /api/orders/pending reduce-only ордера не попадают by design
  // (они «протекторы позиции») — TP не было видно НИГДЕ. Теперь лесенка собирается из orders.
  it('TP-лесенка позиции собирается из активных reduce-only TP-ордеров (ближайшая цель — в tp)', async () => {
    const res = await agent.get('/api/positions').expect(200)
    const rows = res.body as PositionDto[]
    const xrp = rows.find((p) => p.symbol === 'XRPUSDT')!
    // long: ближайшая цель — меньшая цена; исполненный TP в лесенку не попадает.
    expect(xrp.tps).toEqual(['0.62', '0.68'])
    expect(xrp.tp).toBe('0.62')
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

  it('id позиции — синтетический курсор `${channelId}:${symbol}`', async () => {
    const res = await agent.get('/api/positions').expect(200)
    const rows = res.body as PositionDto[]
    const btc = rows.find((p) => p.symbol === 'BTCUSDT')!
    expect(btc.id).toBe(`${CHANNEL_A_ID}:BTCUSDT`)
  })

  it('?limit=2 усекает список позиций (3 открытые -> 2)', async () => {
    const res = await agent.get('/api/positions?limit=2').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(2)
  })

  it('?before=<id первой страницы> отдаёт keyset-продолжение без пересечения и без пропусков', async () => {
    const page1 = (await agent.get('/api/positions?limit=2').expect(200)).body as PositionDto[]
    expect(page1).toHaveLength(2)
    const cursor = page1[1]!.id

    const page2 = (await agent.get(`/api/positions?limit=2&before=${encodeURIComponent(cursor)}`).expect(200))
      .body as PositionDto[]
    expect(page2).toHaveLength(1) // всего 3 открытых -> после 2 остаётся 1

    const allIds = [...page1, ...page2].map((p) => p.id)
    expect(new Set(allIds).size).toBe(3) // ни дублей, ни пропусков
  })

  it('?before=<мусорный курсор без ":"> тихо игнорируется (не 500)', async () => {
    const res = await agent.get('/api/positions?before=garbage').expect(200)
    const rows = res.body as PositionDto[]
    expect(rows).toHaveLength(3) // курсор проигнорирован — как будто before не передавали
  })

  it('пагинация стабильна при бампе updated_at (mark-тик) — ключ opened_at, а не volatile updated_at (F6)', async () => {
    const page1 = (await agent.get('/api/positions?limit=2').expect(200)).body as PositionDto[]
    expect(page1).toHaveLength(2)
    const cursor = page1[1]!.id

    // Симулируем mark-тик apply-tick.ts: бампаем updated_at СТРОКИ-КУРСОРА "в будущее". Со старым
    // ключом (updated_at) подзапрос курсора резолвил бы это новое значение → граница страницы
    // уезжала → дубли/пропуски. С opened_at (неизменен) граница стабильна.
    const [curChan, curSym] = cursor.split(':')
    await db
      .updateTable('positions')
      .set({ updated_at: new Date(Date.UTC(2027, 0, 1)) })
      .where('channel_id', '=', Number(curChan))
      .where('symbol', '=', curSym!)
      .execute()

    const page2 = (await agent.get(`/api/positions?limit=2&before=${encodeURIComponent(cursor)}`).expect(200))
      .body as PositionDto[]
    expect(page2).toHaveLength(1) // граница не поехала: остаётся ровно 1 непоказанная
    const allIds = [...page1, ...page2].map((p) => p.id)
    expect(new Set(allIds).size).toBe(3) // ни дублей, ни пропусков несмотря на бамп updated_at
  })
})

describe('GET /api/positions/history', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/positions/history')
    expect(res.status).toBe(401)
  })

  it('по умолчанию (status=closed) отдаёт закрытые сделки, cancelled исключены', async () => {
    const res = await agent.get('/api/positions/history').expect(200)
    const rows = res.body as ClosedTradeDto[]
    const refs = rows.map((r) => r.tradeRef)
    expect(refs).toContain('TR-7001')
    expect(refs).toContain('TR-7002')
    expect(refs).not.toContain('TR-7003') // cancelled
    expect(rows.every((r) => r.status === 'closed')).toBe(true)
  })

  it('TR-7001: closeReason tp (из tp_hit), exitPrice — взвеш. средняя reduce-only филлов', async () => {
    const res = await agent.get(`/api/positions/history?channel=${CHANNEL_A_ID}`).expect(200)
    const rows = res.body as ClosedTradeDto[]
    const t = rows.find((r) => r.tradeRef === 'TR-7001')!
    expect(t.closeReason).toBe('tp')
    expect(t.exitPrice).toBe('61200')
    expect(t.avgEntry).toBe('60000')
    expect(t.realizedPnl).toBe('+$150.50')
    expect(t.isWin).toBe(true)
    expect(t.leverage).toBe('10x')
    expect(t.side).toBe('long')
    expect(t.symbol).toBe('BTCUSDT')
    expect(t.durationMs).toBe(3_600_000) // 1 час
    expect(t.status).toBe('closed')
    expect(t.channelId).toBe(CHANNEL_A_ID)
  })

  it('TR-7002: closeReason sl (из sl_hit), exitPrice null (нет исполнений), realized со знаком', async () => {
    const res = await agent.get(`/api/positions/history?channel=${CHANNEL_A_ID}`).expect(200)
    const rows = res.body as ClosedTradeDto[]
    const t = rows.find((r) => r.tradeRef === 'TR-7002')!
    expect(t.closeReason).toBe('sl')
    expect(t.exitPrice).toBeNull()
    expect(t.realizedPnl).toBe('-$40.25')
    expect(t.isWin).toBe(false)
  })

  it('status=cancelled отдаёт только отменённые — closeReason cancelled, durationMs 0, avgEntry 0', async () => {
    const res = await agent.get('/api/positions/history?status=cancelled').expect(200)
    const rows = res.body as ClosedTradeDto[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
    const t = rows.find((r) => r.tradeRef === 'TR-7003')!
    expect(t.closeReason).toBe('cancelled')
    expect(t.durationMs).toBe(0)
    expect(t.avgEntry).toBe('0')
  })

  it('status=all включает и closed, и cancelled', async () => {
    const res = await agent.get('/api/positions/history?status=all').expect(200)
    const refs = (res.body as ClosedTradeDto[]).map((r) => r.tradeRef)
    expect(refs).toContain('TR-7001')
    expect(refs).toContain('TR-7003')
  })

  it('keyset по human_ref: limit=1 + before отдаёт следующую страницу (channel A, closed)', async () => {
    const page1 = (await agent.get(`/api/positions/history?channel=${CHANNEL_A_ID}&limit=1`).expect(200))
      .body as ClosedTradeDto[]
    expect(page1).toHaveLength(1)
    expect(page1[0]!.tradeRef).toBe('TR-7001') // closed_at 07-11 свежее 07-10

    const page2 = (
      await agent.get(`/api/positions/history?channel=${CHANNEL_A_ID}&limit=1&before=${page1[0]!.tradeRef}`).expect(200)
    ).body as ClosedTradeDto[]
    expect(page2).toHaveLength(1)
    expect(page2[0]!.tradeRef).toBe('TR-7002')
  })

  it('фильтр channel сужает историю по каналу', async () => {
    const res = await agent.get(`/api/positions/history?channel=${CHANNEL_A_ID}`).expect(200)
    const rows = res.body as ClosedTradeDto[]
    expect(rows.every((r) => r.channelId === CHANNEL_A_ID)).toBe(true)
    expect(rows.some((r) => r.tradeRef === 'TR-9103')).toBe(false) // это channel B (SOL closed)
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

  it('realizedPnl = SUM(realized) по ВСЕМ сделкам, totalPnl = unrealised(open) + realized', async () => {
    const res = await agent.get('/api/positions/stats').expect(200)
    const stats = res.body as PositionStatsDto
    // TR-7001(150.50) + TR-7002(-40.25) + TR-9105(-0.25, комиссия входа по ОТКРЫТОЙ сделке)
    // + TR-9106(20.00, ЧАСТИЧНО закрытая) = 130.00. Первые два слагаемых учитывались и раньше,
    // два последних фильтр status='closed' выбрасывал, хотя деньги уже двинулись.
    expect(stats.realizedPnl).toBe('+$130.00')
    // 500 (unrealised open) + 130.00 (realized) = 630.00 — ровно изменение депозита.
    expect(stats.totalPnl).toBe('+$630.00')
  })
})

describe('GET /api/positions/stats/by-channel', () => {
  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/positions/stats/by-channel')
    expect(res.status).toBe(401)
  })

  it('группирует PnL по каналам с winRate по решённым исходам', async () => {
    const res = await agent.get('/api/positions/stats/by-channel').expect(200)
    const rows = res.body as ChannelPnlDto[]

    const a = rows.find((r) => r.channelId === CHANNEL_A_ID)!
    expect(a.openPositions).toBe(2) // BTC + ETH открыты
    expect(a.unrealisedPnl).toBe('+$500.00')
    expect(a.realizedPnl).toBe('+$110.00') // TR-7001 + TR-7002 + комиссия открытой TR-9105
    expect(a.totalPnl).toBe('+$610.00')
    expect(a.winRate).toBe('50%') // 1 win / 2 decided (TR-7001 win, TR-7002 loss)

    const b = rows.find((r) => r.channelId === CHANNEL_B_ID)!
    expect(b.openPositions).toBe(1) // XRP (SOL size=0 не в счёте)
    expect(b.unrealisedPnl).toBe('+$0.00')
    expect(b.realizedPnl).toBe('+$20.00') // TR-9103 closed (0) + TR-9106 частично закрытая (20)
    expect(b.winRate).toBe('—') // is_win null -> исход неизвестен
  })
})
