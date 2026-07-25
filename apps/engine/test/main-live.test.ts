import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { BybitAdapter, type BybitAdapterRestClient } from '../src/execution/bybit.adapter.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { createExecutionPort } from '../src/execution/port.js'
import { BybitPrivateWs } from '../src/bybit/private-ws.js'
import type { ReconcileRestClient } from '../src/bybit/reconcile.js'
import type { BybitRestClient, CreateOrderParams, Order, Position, SetTradingStopParams } from '../src/bybit/rest-client.js'
import { decryptSecret, encryptSecret, getChannelKeys } from '../src/bybit/channel-keys.js'
import { initLiveRuntime, sweepExpiredLimitOrders } from '../src/main.js'

// Задача 5 (Ф3, live-режим в main.ts): task-5-brief.md + LOOP_STATE.md.
//  1) initLiveRuntime — единая точка ветвления EXECUTION_MODE=live в main.ts: реконсиляция ->
//     приватный WS (сконструирован, НЕ подключён) -> ExecutionPort (BybitAdapter). dry_run-ветка
//     фабрики createExecutionPort уже покрыта bybit-adapter.test.ts (describe('createExecutionPort')) —
//     здесь НЕ дублируем, тестируем только НОВОЕ (initLiveRuntime/sweepExpiredLimitOrders/getChannelKeys).
//  2) sweepExpiredLimitOrders — TTL-свип отложенных лимиток (design spec §9): один и тот же код
//     работает в dry_run (DryRunAdapter — cancelOrder только в БД) и live (BybitAdapter — реальный
//     rest.cancelOrder) БЕЗ единого if по режиму — ветвление уже сделано фабрикой createExecutionPort.
//  3) getChannelKeys/encryptSecret/decryptSecret — per-channel ключи Bybit с фолбэком на env.
//
// main.ts НЕ импортируется как entrypoint здесь — top-level `main().catch(...)` в конце файла
// защищён проверкой `isMainModule` (import.meta.url === file://process.argv[1]), иначе сам факт
// импорта поднимал бы весь движок (LISTEN/tickersFeed/live-подключение) как побочный эффект теста.

let db: Kysely<DB>
const CHANNEL_ID = 900
const CHANNEL_ORD = 9
const DAY_MS = 24 * 60 * 60 * 1000

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch-ttl', 'channel', 'ch1')
  `.execute(db)
  await db
    .insertInto('channel_settings')
    .values({
      channel_id: CHANNEL_ID,
      enabled: true,
      trade_size: '500',
      max_leverage: '50',
      cross_margin: true,
      no_sl_policy: 'attach_protective_sl',
      no_sl_buffer_sec: 0,
      add_sizing_mode: 'trade_size',
      mirror_manual_fraction: false,
      limit_ttl_sec: 604_800, // дефолт §9 — 7 дней
      updated_at: new Date(),
    })
    .execute()
})

let tgMessageSeq = 900_000

/** actions.id — FK-якорь orders.action_id (NOT NULL); message_id тоже FK, поэтому создаём цепочку. */
async function seedActionId(): Promise<string> {
  const tgMessageId = tgMessageSeq++
  const message = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
      tg_message_id: tgMessageId,
      is_topic_message: false,
      text: '',
      has_media: false,
      msg_ts: new Date(),
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
      side: 'long',
      symbol: 'BTCUSDT',
      method: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return action.id
}

interface SeedOrderOpts {
  purpose?: 'entry' | 'add' | 'tp' | 'sl' | 'close'
  orderType?: 'market' | 'limit'
  status?: 'submitted' | 'filled' | 'cancelled'
  createdAt: Date
  ttlExpiresAt?: Date | null
  symbol?: string
}

/** Вставляет строку orders напрямую (минуя ExecutionPort) — sweepExpiredLimitOrders работает
 *  ЧИСТО с состоянием БД, adapter-специфичная постановка ордера здесь не нужна и не тестируется
 *  (это уже покрыто bybit-adapter.test.ts/dry-run.adapter.test.ts). */
async function seedOrder(orderLinkId: string, opts: SeedOrderOpts): Promise<void> {
  const actionId = await seedActionId()
  await db
    .insertInto('orders')
    .values({
      action_id: actionId,
      channel_id: CHANNEL_ID,
      symbol: opts.symbol ?? 'BTCUSDT',
      order_link_id: orderLinkId,
      purpose: opts.purpose ?? 'entry',
      side: 'long',
      order_type: opts.orderType ?? 'limit',
      status: opts.status ?? 'submitted',
      created_at: opts.createdAt,
      ttl_expires_at: opts.ttlExpiresAt ?? null,
    })
    .execute()
}

async function orderStatus(orderLinkId: string): Promise<string> {
  const row = await db.selectFrom('orders').select('status').where('order_link_id', '=', orderLinkId).executeTakeFirstOrThrow()
  return row.status
}

/**
 * Мок BybitRestClient, покрывающий И reconcileOnStart (getPositions/getOpenOrders — пустой
 * аккаунт/журнал), И BybitAdapter (switchMode/setLeverage/createOrder/setTradingStop/cancelOrder) —
 * тот же приём мока (без сети), что и bybit-adapter.test.ts/reconcile.test.ts, объединённый в один
 * набор ради переиспользования между describe-блоками initLiveRuntime и sweepExpiredLimitOrders.
 */
// initLiveRuntime синхронизирует часы биржи (bybit/server-time.ts) до первой подписи, поэтому в
// срез мока добавлены syncClock/serverNowMs — тем же приёмом «узкий Pick», что и остальные части.
type MockRest = BybitAdapterRestClient & ReconcileRestClient & Pick<BybitRestClient, 'syncClock' | 'serverNowMs'>

function createMockRest(): { rest: MockRest; calls: string[] } {
  const calls: string[] = []
  const seenOrderLinkIds = new Set<string>()
  let orderSeq = 0

  const rest: MockRest = {
    getPositions: vi.fn(async (_symbol?: string): Promise<Position[]> => {
      calls.push('getPositions')
      return []
    }),
    getOpenOrders: vi.fn(async (_symbol?: string): Promise<Order[]> => {
      calls.push('getOpenOrders')
      return []
    }),
    // Догон истории (реконсиляция дочитывает исполнения/PnL/статусы ордеров). Пустая история —
    // поведение стартовой сверки в этом тесте не меняется.
    getExecutions: vi.fn(async () => {
      calls.push('getExecutions')
      return []
    }),
    getOrderHistory: vi.fn(async () => {
      calls.push('getOrderHistory')
      return []
    }),
    getClosedPnl: vi.fn(async () => {
      calls.push('getClosedPnl')
      return []
    }),
    switchMode: vi.fn(async (symbol: string, mode: 0 | 3) => {
      calls.push(`switchMode:${symbol}:${mode}`)
      return { ok: true as const }
    }),
    setLeverage: vi.fn(async (symbol: string, leverage: string) => {
      calls.push(`setLeverage:${symbol}:${leverage}`)
      return { ok: true as const, idempotent: false }
    }),
    createOrder: vi.fn(async (params: CreateOrderParams) => {
      calls.push(`createOrder:${params.orderLinkId}`)
      if (seenOrderLinkIds.has(params.orderLinkId)) {
        return { orderId: '', orderLinkId: params.orderLinkId, ok: true as const, idempotent: true }
      }
      seenOrderLinkIds.add(params.orderLinkId)
      orderSeq += 1
      return { orderId: `bybit-order-${orderSeq}`, orderLinkId: params.orderLinkId, ok: true as const, idempotent: false }
    }),
    setTradingStop: vi.fn(async (_params: SetTradingStopParams) => {
      calls.push('setTradingStop')
      return { ok: true as const }
    }),
    cancelAll: vi.fn(async (symbol: string) => {
      calls.push(`cancelAll:${symbol}`)
      return { ok: true as const }
    }),
    cancelOrder: vi.fn(async (params: { symbol: string; orderLinkId: string }) => {
      calls.push(`cancelOrder:${params.orderLinkId}`)
      return { ok: true as const }
    }),
    // Часы биржи (bybit/server-time.ts): initLiveRuntime синхронизирует их ДО первой подписи —
    // в моке достаточно нулевой поправки, сеть тест не трогает.
    syncClock: vi.fn(async () => {
      calls.push('syncClock')
      return 0
    }),
    serverNowMs: vi.fn(() => Date.now()),
  }

  return { rest, calls }
}

describe('initLiveRuntime — EXECUTION_MODE=live: реконсиляция -> приватный WS -> ExecutionPort', () => {
  it('вызывает reconcileOnStart (мок rest), возвращает BybitAdapter и сконструированный (не подключённый) BybitPrivateWs', async () => {
    const { rest, calls } = createMockRest()

    const runtime = await initLiveRuntime(db, rest as unknown as BybitRestClient, 'testnet', { apiKey: 'k', apiSecret: 's' })

    // Реконсиляция реально вызвана (§14: "при старте" — до подъёма пайплайна).
    expect(calls).toContain('getPositions')
    expect(calls).toContain('getOpenOrders')
    // Пустой журнал/аккаунт -> всё по нулям (тот же контракт, что и живая проверка на testnet).
    expect(runtime.reconcileResult).toEqual({ opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, phantomsZeroed: 0, reattributedExecutions: 0 })
    // Фабрика createExecutionPort('live', ...) действительно дала BybitAdapter.
    expect(runtime.executionPort).toBeInstanceOf(BybitAdapter)
    // Приватный WS сконструирован (готов к .start()), но НЕ подключается сам по себе —
    // conn() зовётся только из start() (private-ws.ts) — эта функция start() не вызывает.
    expect(runtime.privateWs).toBeInstanceOf(BybitPrivateWs)
  })

  it("dry_run: createExecutionPort('dry_run') не требует и не создаёт ни одного live-ресурса", () => {
    // Симметричная проверка стороны, за которую отвечает main() (initLiveRuntime дry_run вообще
    // не вызывает) — сама фабрика уже тестируется в bybit-adapter.test.ts::createExecutionPort.
    const port = createExecutionPort('dry_run')
    expect(port).toBeInstanceOf(DryRunAdapter)
  })
})

describe('sweepExpiredLimitOrders — TTL-отмена отложенных лимиток (design spec §9)', () => {
  it('entry-лимитка старше limit_ttl_sec (7 дней) -> cancelOrder вызван (мок rest); свежая — не тронута', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    await seedOrder('EXPIRED-E0', { createdAt: new Date(now.getTime() - 8 * DAY_MS) })
    await seedOrder('FRESH-E0', { createdAt: new Date(now.getTime() - 1 * DAY_MS) })

    const { rest, calls } = createMockRest()
    const port = new BybitAdapter(rest, 'testnet')

    const cancelled = await sweepExpiredLimitOrders(db, port, now)

    expect(cancelled).toBe(1)
    expect(calls).toEqual(['cancelOrder:EXPIRED-E0'])
    expect(await orderStatus('EXPIRED-E0')).toBe('cancelled')
    expect(await orderStatus('FRESH-E0')).toBe('submitted')
  })

  it('dry_run: просроченная лимитка помечается cancelled в БД, БЕЗ единого сетевого вызова', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    await seedOrder('DRY-EXPIRED-E0', { createdAt: new Date(now.getTime() - 8 * DAY_MS) })

    const cancelled = await sweepExpiredLimitOrders(db, new DryRunAdapter(), now)

    expect(cancelled).toBe(1)
    expect(await orderStatus('DRY-EXPIRED-E0')).toBe('cancelled')
  })

  it('явный ttl_expires_at в прошлом отменяет РАНЬШЕ дефолтных 7 дней (COALESCE — приоритет явного поля)', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    // created_at — час назад (далеко от 7-дневного дефолта), но ttl_expires_at явно просрочен.
    await seedOrder('TTL-OVERRIDE-E0', {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      ttlExpiresAt: new Date(now.getTime() - 1000),
    })

    const { rest, calls } = createMockRest()
    const cancelled = await sweepExpiredLimitOrders(db, new BybitAdapter(rest, 'testnet'), now)

    expect(cancelled).toBe(1)
    expect(calls).toEqual(['cancelOrder:TTL-OVERRIDE-E0'])
  })

  it('TP/SL — не "отложенные лимитки" §9 (протекторы позиции) — TTL-свип их не трогает, даже старые', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    const old = new Date(now.getTime() - 30 * DAY_MS)
    await seedOrder('TP-OLD-T0', { purpose: 'tp', createdAt: old })
    await seedOrder('SL-OLD-S0', { purpose: 'sl', createdAt: old })

    const { rest, calls } = createMockRest()
    const cancelled = await sweepExpiredLimitOrders(db, new BybitAdapter(rest, 'testnet'), now)

    expect(cancelled).toBe(0)
    expect(calls).toEqual([])
    expect(await orderStatus('TP-OLD-T0')).toBe('submitted')
    expect(await orderStatus('SL-OLD-S0')).toBe('submitted')
  })

  it('market-ордер (order_type<>limit) не трогается — TTL применим только к отложенным лимиткам', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    await seedOrder('MARKET-OLD-E0', { orderType: 'market', createdAt: new Date(now.getTime() - 30 * DAY_MS) })

    const { rest, calls } = createMockRest()
    const cancelled = await sweepExpiredLimitOrders(db, new BybitAdapter(rest, 'testnet'), now)

    expect(cancelled).toBe(0)
    expect(calls).toEqual([])
  })

  it('уже filled/cancelled лимитки повторно не выбираются свипом', async () => {
    const now = new Date('2026-07-11T12:00:00Z')
    const old = new Date(now.getTime() - 30 * DAY_MS)
    await seedOrder('ALREADY-FILLED-E0', { status: 'filled', createdAt: old })
    await seedOrder('ALREADY-CANCELLED-E0', { status: 'cancelled', createdAt: old })

    const { rest, calls } = createMockRest()
    const cancelled = await sweepExpiredLimitOrders(db, new BybitAdapter(rest, 'testnet'), now)

    expect(cancelled).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('getChannelKeys / encryptSecret / decryptSecret — ключи Bybit per-channel с фолбэком на env', () => {
  const originalApiKey = process.env.BYBIT_API_KEY
  const originalApiSecret = process.env.BYBIT_API_SECRET

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.BYBIT_API_KEY
    else process.env.BYBIT_API_KEY = originalApiKey
    if (originalApiSecret === undefined) delete process.env.BYBIT_API_SECRET
    else process.env.BYBIT_API_SECRET = originalApiSecret
  })

  it('encryptSecret/decryptSecret — round-trip под ENCRYPTION_KEY (.env, 64 hex-символа)', () => {
    const plaintext = 'super-secret-bybit-value-!@#'
    const encoded = encryptSecret(plaintext)
    expect(encoded.split(':')).toHaveLength(3) // iv:authTag:ciphertext
    expect(decryptSecret(encoded)).toBe(plaintext)
  })

  it('канал с bybit_api_key_enc/bybit_api_secret_enc -> расшифрованные ключи канала, НЕ env', async () => {
    const channelId = 950
    await sql`
      INSERT INTO channels (id, ord, key, source_kind, adapter_id, bybit_api_key_enc, bybit_api_secret_enc)
      VALUES (${channelId}, 1, 'ch-enc', 'channel', 'ch1', ${encryptSecret('sub-api-key')}, ${encryptSecret('sub-api-secret')})
    `.execute(db)
    process.env.BYBIT_API_KEY = 'env-key-must-not-be-used'
    process.env.BYBIT_API_SECRET = 'env-secret-must-not-be-used'

    const keys = await getChannelKeys(db, channelId)

    expect(keys).toEqual({ apiKey: 'sub-api-key', apiSecret: 'sub-api-secret' })
  })

  it('канал БЕЗ субаккаунта (bybit_api_key_enc IS NULL, обычное состояние Ф3) -> фолбэк на env', async () => {
    const channelId = 951
    await sql`
      INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${channelId}, 2, 'ch-noenc', 'channel', 'ch1')
    `.execute(db)
    process.env.BYBIT_API_KEY = 'env-key'
    process.env.BYBIT_API_SECRET = 'env-secret'

    const keys = await getChannelKeys(db, channelId)

    expect(keys).toEqual({ apiKey: 'env-key', apiSecret: 'env-secret' })
  })

  it('channelId=null -> глобальный вызов (единый движок Ф3) сразу берёт env, без похода в БД', async () => {
    process.env.BYBIT_API_KEY = 'global-env-key'
    process.env.BYBIT_API_SECRET = 'global-env-secret'

    const keys = await getChannelKeys(db, null)

    expect(keys).toEqual({ apiKey: 'global-env-key', apiSecret: 'global-env-secret' })
  })

  it('ни субаккаунта, ни env-ключей -> бросает явную ошибку (не тихий undefined)', async () => {
    delete process.env.BYBIT_API_KEY
    delete process.env.BYBIT_API_SECRET

    await expect(getChannelKeys(db, null)).rejects.toThrow()
  })
})
