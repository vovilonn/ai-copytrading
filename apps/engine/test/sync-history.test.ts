// Догон истории с биржи: восстановление после даунтайма + подтягивание РУЧНЫХ действий оператора.
//
// Требование заказчика: «полная синхронизация, даже если сервис лежал день; чтобы подтягивалось, если
// я закрою позицию напрямую на байбите, зафиксирую часть, подвину тп/сл».
//
// До этих фиксов не выполнялось даже при живом WS: ручное закрытие TR-1204 оставило в журнале
// realized_pnl=0 / fees_paid=0 / is_win=NULL при реальном убытке −0.046 — филлы лежали осиротевшими
// (trade_id=NULL), потому что атрибуция искала ордер ТОЛЬКО по нашему order_link_id.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Decimal } from 'decimal.js'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import type { Side } from 'shared/domain.js'
import { openTrade, acquireSymbol, addLeg, closeTrade } from '../src/state/trades.js'
import { reconcileOnStart, type ReconcileRestClient } from '../src/bybit/reconcile.js'
import type { ClosedPnl, Execution, Order, Position } from '../src/bybit/rest-client.js'

const CHANNEL_ID = Number(CHANNEL_SOURCES[0]!.channelId)

let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await db
    .insertInto('channels')
    .values({
      id: CHANNEL_ID,
      ord: 1,
      key: 'ch-test',
      source_kind: 'channel',
      topic_id: null,
      adapter_id: 'ch1-structured',
      title: 'test',
      handle: null,
      status: 'active',
      last_seen_message_id: 0,
      bybit_sub_uid: null,
      bybit_api_key_enc: null,
      bybit_api_secret_enc: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
})

/** Сделка с НАШИМ ('K') входным ордером — атрибуция ручных филлов требует его наличия. */
async function seedLiveTrade(opts: {
  symbol: string
  side?: Side
  openedAt?: Date
  status?: 'open' | 'closed'
  entryLinkId?: string
}): Promise<{ tradeId: string; entryLinkId: string }> {
  const side = opts.side ?? 'long'
  const openedAt = opts.openedAt ?? new Date(Date.now() - 60 * 60_000)

  const message = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
      tg_message_id: Math.floor(Math.random() * 1_000_000),
      is_topic_message: false,
      text: 'seed',
      has_media: false,
      msg_ts: openedAt,
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const action = await db
    .insertInto('actions')
    .values({
      message_id: message.id,
      channel_id: CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side,
      symbol: opts.symbol,
      pair: opts.symbol,
      method: 'auto',
      status: 'executed',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const trade = await openTrade(db, {
    channelId: CHANNEL_ID,
    symbol: opts.symbol,
    side,
    openedActionId: action.id,
    openedMsgId: message.id,
  })

  const leg = await addLeg(db, {
    tradeId: trade.tradeId,
    legIndex: 0,
    kind: 'entry',
    sourceMessageId: message.id,
    sourceActionId: action.id,
    requestedQty: '0.1',
  })

  const entryLinkId = opts.entryLinkId ?? `K01-${Math.floor(Math.random() * 100000)}-00-E0`
  await db
    .insertInto('orders')
    .values({
      action_id: action.id,
      trade_id: trade.tradeId,
      leg_id: leg.legId,
      channel_id: CHANNEL_ID,
      symbol: opts.symbol,
      order_link_id: entryLinkId,
      purpose: 'entry',
      side,
      order_type: 'market',
      reduce_only: false,
      qty: '0.1',
      status: 'submitted',
    })
    .execute()

  await db
    .updateTable('trades')
    .set({ status: opts.status ?? 'open', avg_entry: '100', size: '0.1', opened_at: openedAt })
    .where('id', '=', trade.tradeId)
    .execute()

  await acquireSymbol(db, { channelId: CHANNEL_ID, symbol: opts.symbol, tradeId: trade.tradeId })

  if (opts.status === 'closed') {
    await closeTrade(db, { tradeId: trade.tradeId, status: 'closed' })
  }

  return { tradeId: trade.tradeId, entryLinkId }
}

function makeExecution(overrides: Partial<Execution> & { symbol: string; execId: string }): Execution {
  return {
    orderId: `oid-${overrides.execId}`,
    orderLinkId: '',
    side: 'Sell',
    execQty: '0.1',
    execPrice: '110',
    execFee: '0.005',
    execValue: '11',
    execType: 'Trade',
    closedSize: '0.1',
    leavesQty: '0',
    isMaker: false,
    execTime: String(Date.now() - 30 * 60_000),
    seq: 1,
    orderPrice: '110',
    ...overrides,
  } as Execution
}

function makeClosedPnl(overrides: Partial<ClosedPnl> & { symbol: string; orderId: string }): ClosedPnl {
  return {
    side: 'Sell',
    qty: '0.1',
    closedSize: '0.1',
    avgEntryPrice: '100',
    avgExitPrice: '110',
    closedPnl: '1',
    openFee: '0.005',
    closeFee: '0.005',
    fillCount: '1',
    leverage: '5',
    createdTime: String(Date.now() - 30 * 60_000),
    updatedTime: String(Date.now() - 30 * 60_000),
    ...overrides,
  } as ClosedPnl
}

function makeRest(history: {
  positions?: Position[]
  openOrders?: Order[]
  executions?: Execution[]
  orderHistory?: Order[]
  closedPnl?: ClosedPnl[]
}): ReconcileRestClient {
  return {
    getPositions: vi.fn(async () => history.positions ?? []),
    getOpenOrders: vi.fn(async () => history.openOrders ?? []),
    cancelOrder: vi.fn(async () => ({ ok: true as const })),
    getExecutions: vi.fn(async () => history.executions ?? []),
    getOrderHistory: vi.fn(async () => history.orderHistory ?? []),
    getClosedPnl: vi.fn(async () => history.closedPnl ?? []),
  }
}

describe('догон истории: РУЧНЫЕ действия оператора на бирже', () => {
  it('ручное закрытие позиции подтягивается: филл привязан к сделке, PnL и комиссии посчитаны, is_win выставлен', async () => {
    const { tradeId } = await seedLiveTrade({ symbol: 'SOLUSDT' })

    // Оператор закрыл позицию руками в интерфейсе Bybit: orderLinkId ЧУЖОЙ, наших ордеров нет.
    const rest = makeRest({
      executions: [
        makeExecution({
          symbol: 'SOLUSDT',
          execId: 'exec-manual-1',
          orderId: 'oid-manual',
          orderLinkId: 'MANUALCLOSE-123',
          createType: 'CreateByClosing',
          execFee: '0.0043',
        }),
      ],
      closedPnl: [makeClosedPnl({ symbol: 'SOLUSDT', orderId: 'oid-manual', closedPnl: '1', openFee: '0.004', closeFee: '0.0043' })],
      positions: [], // позиции на бирже больше нет — сделка должна закрыться
    })

    await reconcileOnStart(db, rest)

    const exec = await db
      .selectFrom('executions')
      .selectAll()
      .where('bybit_exec_id', '=', 'exec-manual-1')
      .executeTakeFirstOrThrow()
    expect(exec.trade_id).toBe(tradeId) // ← раньше здесь был NULL, и PnL терялся навсегда
    expect(exec.source).toBe('rest')

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    // gross = closedPnl + openFee + closeFee = 1 + 0.004 + 0.0043 (в БД хранится БРУТТО)
    expect(new Decimal(trade.realized_pnl).toFixed(4)).toBe('1.0083')
    expect(new Decimal(trade.fees_paid).toString()).toBe('0.0043') // писателя у этого поля не было вовсе
    expect(trade.status).toBe('closed')
    expect(trade.is_win).toBe(true)
    // Ручное вмешательство: канал больше не двигает SL/TP этой сделки (решение заказчика).
    expect(trade.manual_override).toBe(true)
  })

  it('филл НАШЕГО ордера, чья строка ещё не закоммичена, НЕ считается ручным действием', async () => {
    // Живой e2e: ордер уходит на биржу ВНУТРИ ещё не закоммиченной транзакции пайплайна, а филл
    // прилетает за миллисекунды — лукап по order_link_id промахивается на СВОЁМ же ордере.
    // Раньше такой промах доходил до эвристики «ручное действие», и ЖИВОЙ сделке проставлялся
    // manual_override: канал молча переставал двигать её стоп (в логе одного прогона — 6 подряд).
    const { tradeId } = await seedLiveTrade({ symbol: 'ADAUSDT' })

    const rest = makeRest({
      executions: [
        makeExecution({
          symbol: 'ADAUSDT',
          execId: 'exec-ours-uncommitted',
          orderId: 'oid-ours',
          // Формат ключа движка (order-link-id.ts) — строки orders для него ещё нет.
          orderLinkId: 'K01-999-00-C0',
          createType: 'CreateByUser',
        }),
      ],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.manual_override).toBe(false)
    expect(trade.needs_review).toBe(false)
  })

  it('филл сработавшего СВОЕГО стопа (пустой orderLinkId) — не ручное действие оператора', async () => {
    // У trading-stop orderLinkId пустой, а lookupOrder на WS-пути не передаётся — раньше такой
    // филл доезжал до эвристики «ручное» и ставил живой сделке manual_override на КАЖДОМ
    // срабатывании нашего же стопа. Признак «наш» здесь — активное владение символом.
    const { tradeId } = await seedLiveTrade({ symbol: 'AVAXUSDT' })

    const rest = makeRest({
      executions: [
        makeExecution({
          symbol: 'AVAXUSDT',
          execId: 'exec-own-stop',
          orderId: 'oid-stop',
          orderLinkId: '',
          createType: 'CreateByStopLoss',
        }),
      ],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(trade.manual_override).toBe(false)
    const exec = await db.selectFrom('executions').selectAll().where('bybit_exec_id', '=', 'exec-own-stop').executeTakeFirstOrThrow()
    expect(exec.trade_id).toBe(tradeId) // PnL сделки всё равно посчитан
  })

  it('ручное вмешательство фиксируется в audit_log — оператор видит, что подтянулось', async () => {
    await seedLiveTrade({ symbol: 'BTCUSDT' })

    const rest = makeRest({
      executions: [
        makeExecution({ symbol: 'BTCUSDT', execId: 'exec-manual-2', orderLinkId: 'MANUAL-xyz', createType: 'CreateByClosing' }),
      ],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    // audit_log не типизирован в Kysely (как и в остальном коде) — читаем сырым SQL.
    const { rows } = await sql<{ action: string }>`
      SELECT action FROM audit_log WHERE action = 'manual_action_detected'
    `.execute(db)
    expect(rows).toHaveLength(1)
  })

  it('филл сработавшего trading-stop (orderLinkId ПУСТОЙ) привязывается через parentOrderLinkId', async () => {
    const { tradeId, entryLinkId } = await seedLiveTrade({ symbol: 'ETHUSDT' })

    // У биржевого SL orderLinkId пустой — единственный мост к сделке это parentOrderLinkId (наш вход).
    const rest = makeRest({
      executions: [
        makeExecution({ symbol: 'ETHUSDT', execId: 'exec-sl-1', orderId: 'oid-sl', orderLinkId: '', createType: 'CreateByStopLoss' }),
      ],
      orderHistory: [
        {
          symbol: 'ETHUSDT',
          orderId: 'oid-sl',
          orderLinkId: '',
          parentOrderLinkId: entryLinkId,
          orderStatus: 'Filled',
          side: 'Sell',
          orderType: 'Market',
          qty: '0.1',
          price: '0',
          reduceOnly: true,
        } as unknown as Order,
      ],
      closedPnl: [makeClosedPnl({ symbol: 'ETHUSDT', orderId: 'oid-sl', closedPnl: '-2', openFee: '0.005', closeFee: '0.005' })],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    const exec = await db.selectFrom('executions').selectAll().where('bybit_exec_id', '=', 'exec-sl-1').executeTakeFirstOrThrow()
    expect(exec.trade_id).toBe(tradeId) // ← иначе сделка закрылась бы по стопу с PnL = 0

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    expect(new Decimal(trade.realized_pnl).toFixed(3)).toBe('-1.990') // gross = -2 + 0.005 + 0.005
    expect(trade.is_win).toBe(false)
  })
})

describe('догон истории: идемпотентность и статусы', () => {
  it('повторный прогон НЕ задваивает PnL (деньги пересчитываются, а не инкрементируются)', async () => {
    const { tradeId } = await seedLiveTrade({ symbol: 'SOLUSDT' })

    const rest = makeRest({
      executions: [makeExecution({ symbol: 'SOLUSDT', execId: 'exec-dup', orderId: 'oid-dup', orderLinkId: 'MANUAL-dup' })],
      closedPnl: [makeClosedPnl({ symbol: 'SOLUSDT', orderId: 'oid-dup', closedPnl: '1', openFee: '0', closeFee: '0' })],
      positions: [],
    })

    await reconcileOnStart(db, rest)
    const first = await db.selectFrom('trades').select('realized_pnl').where('id', '=', tradeId).executeTakeFirstOrThrow()

    await reconcileOnStart(db, rest) // тот же ответ биржи ещё раз
    const second = await db.selectFrom('trades').select('realized_pnl').where('id', '=', tradeId).executeTakeFirstOrThrow()

    expect(new Decimal(second.realized_pnl).toString()).toBe(new Decimal(first.realized_pnl).toString())

    const execs = await db.selectFrom('executions').selectAll().where('bybit_exec_id', '=', 'exec-dup').execute()
    expect(execs).toHaveLength(1) // UNIQUE(bybit_exec_id) — дубль не вставился
  })

  it('терминальный статус биржи применяется безусловно: локальный cancelled -> filled', async () => {
    const { entryLinkId } = await seedLiveTrade({ symbol: 'SOLUSDT' })
    // Локально ордер помечен отменённым (WS пропустил пуш филла) — а на бирже он Filled.
    await db.updateTable('orders').set({ status: 'cancelled' }).where('order_link_id', '=', entryLinkId).execute()

    const rest = makeRest({
      orderHistory: [
        {
          symbol: 'SOLUSDT',
          orderId: 'oid-entry',
          orderLinkId: entryLinkId,
          orderStatus: 'Filled',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.1',
          price: '100',
          reduceOnly: false,
        } as unknown as Order,
      ],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    const order = await db.selectFrom('orders').selectAll().where('order_link_id', '=', entryLinkId).executeTakeFirstOrThrow()
    // Статусы биржи иммутабельны: если она говорит Filled, значит Filled. Протухший 'cancelled'/'submitted'
    // ломал бы cancel_pending (отмена уже исполненного ордера → Bybit 110001 → откат транзакции дельты).
    expect(order.status).toBe('filled')
  })

  it('курсор догона сохраняется в app_state — следующий проход не перечитывает всё заново', async () => {
    const rest = makeRest({ positions: [] })

    await reconcileOnStart(db, rest)

    const cursor = await db.selectFrom('app_state').selectAll().where('key', '=', 'sync:executions').executeTakeFirst()
    expect(cursor).toBeDefined()
    const value = cursor!.value as { windowEndMs: number }
    expect(value.windowEndMs).toBeGreaterThan(0)
  })

  it('фандинг не считается торговым исполнением (в размер/среднюю цену не идёт, только в комиссии)', async () => {
    const { tradeId } = await seedLiveTrade({ symbol: 'SOLUSDT' })

    const rest = makeRest({
      executions: [
        makeExecution({
          symbol: 'SOLUSDT',
          execId: 'exec-funding',
          orderLinkId: '',
          execType: 'Funding',
          closedSize: '0',
          execFee: '0.01',
        }),
      ],
      positions: [],
    })

    await reconcileOnStart(db, rest)

    const trade = await db.selectFrom('trades').selectAll().where('id', '=', tradeId).executeTakeFirstOrThrow()
    // Комиссия фандинга учтена, но PnL от него не появился.
    expect(new Decimal(trade.fees_paid).toString()).toBe('0.01')
    expect(new Decimal(trade.realized_pnl).isZero()).toBe(true)
  })
})
