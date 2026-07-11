// Приватный WS-мост Bybit V5 (задача 3, Ф3; research bybit-execution.md §11/§12/§14).
//
// Хендшейк (§11, ПРОВЕРЕН вживую на testnet): `wss://stream-{testnet|mainnet}.bybit.com/v5/private`,
// `op:auth` c `expires=now+10000ms`, `sign=HMAC_SHA256(secret, "GET/realtime"+expires)` →
// `{"success":true,"op":"auth"}`; затем `op:subscribe` на `[position.linear, order.linear,
// execution.linear, wallet]` → `{"success":true,"op":"subscribe"}`. Тот же приём реконнекта/ping,
// что и публичный `market-data/tickers-feed.ts` (задача 10, Ф1): экспоненциальный backoff на
// 'close', периодический `op:ping` каждые ~20с (Bybit рвёт соединение без пинга), полная
// РЕАУТЕНТИФИКАЦИЯ и переподписка на каждый (ре)коннект — Bybit не переносит auth/подписки между
// TCP-соединениями.
//
// Атрибуция пушей к нашим сущностям (§14, "нет своего #TR-x в position/order — связь через
// orderLinkId/symbol"):
//  - position: у пуша нет orderLinkId (это агрегат по символу) — "один символ, один активный
//    #TR-x" восстанавливается из БД (attributeSymbol ниже): сначала активное владение
//    symbol_ownership (обычный путь — сделка ещё не закрыта в нашем журнале), фолбэк на последнюю
//    зеркальную строку positions с size<>0 (закрывает гонку: pipeline.ts::handleDelta уже мог
//    вызвать closeTrade раньше прихода ЭТОГО пуша — та же сделка, владение уже освобождено).
//  - execution/order: orderLinkId — прямой FK на локальную строку orders (детерминированный ключ
//    из order-link-id.ts), сделка/лега берутся из неё.
//
// Мерж дельт поверх snapshot (тот же приём, что и public tickers, §12): markPrice может
// отсутствовать в конкретном пуше position — COALESCE в UPSERT сохраняет прежнее значение.
// `bybit_seq` — водяной знак (§14): пуш с seq не новее уже сохранённого — устаревший (переупорядочен
// при реконнекте), применять нельзя, иначе можно откатить состояние назад.
//
// Реальные деньги/размеры — Decimal/строки (CLAUDE.md), никогда JS number.

import { createHmac } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network, OrderStatus, Side } from 'shared/domain.js'
import { closeTrade, releaseSymbol } from '../state/trades.js'
import { emitPositionUpsert } from '../pipeline.js'
import type { BybitRestClient } from './rest-client.js'

const WS_HOSTS: Record<Network, string> = {
  testnet: 'wss://stream-testnet.bybit.com/v5/private',
  mainnet: 'wss://stream.bybit.com/v5/private',
}

// §11: "expires = now + 10000ms" — проверено вживую в research.
const AUTH_EXPIRES_MS = 10_000
// Тот же интервал и обоснование, что и tickers-feed.ts (PING_INTERVAL_MS): Bybit рвёт private WS
// без периодического пинга.
const PING_INTERVAL_MS = 20_000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const SUBSCRIBE_TOPICS = ['position.linear', 'order.linear', 'execution.linear', 'wallet']

/** `HMAC_SHA256(secret, "GET/realtime"+expires)` (§11) — отдельная от rest-client.ts::signPayload
 *  подпись: у WS-аутентификации Bybit другой формат сообщения, чем у REST-запросов. */
export function signWsAuth(apiSecret: string, expiresMs: number): string {
  return createHmac('sha256', apiSecret).update(`GET/realtime${expiresMs}`).digest('hex')
}

// ---------------------------------------------------------------------------
// Разбор сырых WS-фреймов — чистые функции (без сети), тестируются напрямую.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}

/** '' трактуется как "поле не пришло" — та же защита, что ticker-message.ts::parseMarkPriceTick
 *  (Bybit иногда шлёт пустую строку вместо отсутствия поля). */
function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

/** Ack на `op:auth`/`op:subscribe`/`op:ping` — отличается от топик-фреймов данных полем `op`
 *  (а не `topic`), протокол Bybit их не смешивает. */
export interface OpAck {
  op: string
  success: boolean
  retMsg: string | null
}

export function parseOpAck(raw: string): OpAck | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  const o = asRecord(msg)
  if (!o) return null
  const op = asNonEmptyString(o.op)
  if (!op) return null
  return { op, success: o.success === true, retMsg: asNonEmptyString(o.ret_msg) }
}

export interface TopicFrame {
  topic: string
  data: unknown[]
}

export function parseFrame(raw: string): TopicFrame | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  const o = asRecord(msg)
  if (!o) return null
  const topic = asNonEmptyString(o.topic)
  if (!topic) return null
  const data = Array.isArray(o.data) ? o.data : []
  return { topic, data }
}

/** Один элемент пуша `position.linear` (§11 — поля из доков, хендшейк проверен вживую, сами
 *  data-пуши на пустом testnet-аккаунте получить не удалось). */
export interface PositionPush {
  symbol: string
  side: string // 'Buy' | 'Sell' | 'None'
  size: string
  entryPrice: string | null
  markPrice: string | null
  liqPrice: string | null
  leverage: string | null
  takeProfit: string | null
  stopLoss: string | null
  unrealisedPnl: string | null
  curRealisedPnl: string | null
  positionStatus: string | null
  seq: number | null
}

export function toPositionPush(item: unknown): PositionPush | null {
  const o = asRecord(item)
  if (!o) return null
  const symbol = asNonEmptyString(o.symbol)
  const side = asNonEmptyString(o.side)
  const size = asNonEmptyString(o.size)
  if (!symbol || !side || size === null) return null
  return {
    symbol,
    side,
    size,
    entryPrice: asNonEmptyString(o.entryPrice),
    markPrice: asNonEmptyString(o.markPrice),
    liqPrice: asNonEmptyString(o.liqPrice),
    leverage: asNonEmptyString(o.leverage),
    takeProfit: asNonEmptyString(o.takeProfit),
    stopLoss: asNonEmptyString(o.stopLoss),
    unrealisedPnl: asNonEmptyString(o.unrealisedPnl),
    curRealisedPnl: asNonEmptyString(o.curRealisedPnl),
    positionStatus: asNonEmptyString(o.positionStatus),
    seq: asNumber(o.seq),
  }
}

/** Один элемент пуша `execution.linear` (§11: `closedSize>0` = закрытие, атрибуция по orderLinkId). */
export interface ExecutionPush {
  symbol: string
  side: string // 'Buy' | 'Sell'
  execId: string
  orderId: string
  orderLinkId: string | null
  execQty: string
  execPrice: string
  closedSize: string
  leavesQty: string
  execFee: string | null
  execPnl: string | null
  execType: string | null
  isMaker: boolean | null
  execTime: string | null
}

export function toExecutionPush(item: unknown): ExecutionPush | null {
  const o = asRecord(item)
  if (!o) return null
  const symbol = asNonEmptyString(o.symbol)
  const side = asNonEmptyString(o.side)
  const execId = asNonEmptyString(o.execId)
  const orderId = asNonEmptyString(o.orderId)
  const execQty = asNonEmptyString(o.execQty)
  const execPrice = asNonEmptyString(o.execPrice)
  if (!symbol || !side || !execId || !orderId || !execQty || !execPrice) return null
  return {
    symbol,
    side,
    execId,
    orderId,
    orderLinkId: asNonEmptyString(o.orderLinkId),
    execQty,
    execPrice,
    closedSize: asNonEmptyString(o.closedSize) ?? '0',
    leavesQty: asNonEmptyString(o.leavesQty) ?? '0',
    execFee: asNonEmptyString(o.execFee),
    execPnl: asNonEmptyString(o.execPnl),
    execType: asNonEmptyString(o.execType),
    isMaker: typeof o.isMaker === 'boolean' ? o.isMaker : null,
    execTime: asNonEmptyString(o.execTime),
  }
}

/** Один элемент пуша `order.linear` — только поля, реально нужные обновлению `orders.status`. */
export interface OrderPush {
  symbol: string | null
  orderId: string
  orderLinkId: string
  orderStatus: string
}

export function toOrderPush(item: unknown): OrderPush | null {
  const o = asRecord(item)
  if (!o) return null
  const orderId = asNonEmptyString(o.orderId)
  const orderLinkId = asNonEmptyString(o.orderLinkId)
  const orderStatus = asNonEmptyString(o.orderStatus)
  if (!orderId || !orderLinkId || !orderStatus) return null
  return { symbol: asNonEmptyString(o.symbol), orderId, orderLinkId, orderStatus }
}

/** Один элемент пуша `wallet` — только totalEquity (кэш equity, опционально по брифу задачи). */
export interface WalletPush {
  accountType: string | null
  totalEquity: string | null
}

export function toWalletPush(item: unknown): WalletPush | null {
  const o = asRecord(item)
  if (!o) return null
  return { accountType: asNonEmptyString(o.accountType), totalEquity: asNonEmptyString(o.totalEquity) }
}

// ---------------------------------------------------------------------------
// Маппинг Bybit-статусов/сторон → доменные типы схемы.
// ---------------------------------------------------------------------------

function mapSide(raw: string): Side | null {
  if (raw === 'Buy') return 'long'
  if (raw === 'Sell') return 'short'
  return null // 'None' — плоская позиция без стороны
}

// Bybit orderStatus (V5 docs) → наш order_status (миграция 001_initial.ts). Untriggered/Triggered —
// условные (TP-лесенка/SL) до/после срабатывания триггера, ещё не поставлены на матчинг —
// трактуем как 'submitted' (висит на бирже, ждёт исполнения/триггера), тот же принцип, что и New.
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  Created: 'submitted',
  New: 'submitted',
  Untriggered: 'submitted',
  Triggered: 'submitted',
  PartiallyFilled: 'partially_filled',
  Filled: 'filled',
  Cancelled: 'cancelled',
  PartiallyFilledCanceled: 'cancelled',
  Deactivated: 'cancelled',
  Rejected: 'rejected',
}

export function mapOrderStatus(raw: string): OrderStatus {
  return ORDER_STATUS_MAP[raw] ?? 'submitted'
}

/** Узкий срез BybitRestClient — только cancelAll (R8: снять висящие TP/SL при полном закрытии),
 *  тот же приём сужения типа мока, что и BybitAdapterRestClient в execution/bybit.adapter.ts. */
export type BybitPrivateWsRestClient = Pick<BybitRestClient, 'cancelAll'>

interface SymbolAttribution {
  channelId: number
  tradeId: string | null
}

/**
 * "symbol → activeTradeId восстанавливаем из своей БД" (research §14). Порядок:
 *  1) активное владение symbol_ownership (released_at IS NULL) — обычный путь, сделка ещё
 *     не закрыта в нашем журнале на момент прихода пуша;
 *  2) фолбэк — последняя зеркальная строка positions с size<>0: закрывает гонку, когда
 *     pipeline.ts::handleDelta (close_remainder) уже вызвал closeTrade/освободил символ РАНЬШЕ,
 *     чем сюда пришёл финальный пуш `position size→0` с той же биржи — без фолбэка этот пуш
 *     не удалось бы атрибутировать (channel_id обязателен для positions), и state UI устарел бы.
 */
async function attributeSymbol(db: Kysely<DB>, symbol: string): Promise<SymbolAttribution | null> {
  const owned = await db
    .selectFrom('symbol_ownership')
    .select(['channel_id', 'trade_id'])
    .where('symbol', '=', symbol)
    .where('released_at', 'is', null)
    .executeTakeFirst()
  if (owned) return { channelId: owned.channel_id, tradeId: owned.trade_id }

  const lastKnown = await db
    .selectFrom('positions')
    .select(['channel_id', 'trade_id'])
    .where('symbol', '=', symbol)
    .where(sql<boolean>`size <> 0`)
    .executeTakeFirst()
  if (lastKnown) return { channelId: lastKnown.channel_id, tradeId: lastKnown.trade_id }

  return null
}

/**
 * Применяет один пуш `position.linear` к зеркалу `positions` + публикует `position.upsert`
 * (и `position.close`, если размер обнулился). Без сети — сетевой `cancelAll` (R8) вызывается
 * ПОСЛЕ коммита транзакции (тот же приём "сеть не должна держать транзакцию БД открытой", что
 * и во всех методах rest-client.ts/bybit.adapter.ts).
 *
 * @returns true, если хотя бы один domain_events реально опубликован (нужен ли pg_notify).
 */
export async function applyPositionPush(
  db: Kysely<DB>,
  push: PositionPush,
  rest: BybitPrivateWsRestClient,
): Promise<boolean> {
  const attribution = await attributeSymbol(db, push.symbol)
  if (!attribution) {
    console.warn(`[private-ws] пуш position по ${push.symbol}: владение символом не найдено в БД — пропускаю`)
    return false
  }
  const { channelId, tradeId } = attribution
  const isFlat = new Decimal(push.size).isZero()
  const side = mapSide(push.side)

  let notifyNeeded = false
  let shouldCancelAll = false

  await db.transaction().execute(async (trx) => {
    if (push.seq !== null) {
      // Водяной знак (§14): пуш не новее уже сохранённого seq — переупорядочен реконнектом,
      // применять нельзя (откатил бы состояние назад).
      const current = await trx
        .selectFrom('positions')
        .select('bybit_seq')
        .where('channel_id', '=', channelId)
        .where('symbol', '=', push.symbol)
        .executeTakeFirst()
      if (current && current.bybit_seq !== null && push.seq <= current.bybit_seq) return
    }

    await sql`
      INSERT INTO positions (
        channel_id, symbol, trade_id, side, size, avg_price, mark_price, liq_price,
        leverage, unrealised_pnl, cur_realised_pnl, take_profit, stop_loss, position_status,
        bybit_seq, updated_at
      ) VALUES (
        ${channelId}, ${push.symbol}, ${tradeId}::uuid, ${side}::side_t, ${push.size}::numeric,
        ${push.entryPrice}::numeric, ${push.markPrice}::numeric, ${push.liqPrice}::numeric,
        ${push.leverage}::numeric, ${push.unrealisedPnl}::numeric, ${push.curRealisedPnl}::numeric,
        ${push.takeProfit}::numeric, ${push.stopLoss}::numeric, ${push.positionStatus},
        ${push.seq}, now()
      )
      ON CONFLICT (channel_id, symbol) DO UPDATE SET
        trade_id = EXCLUDED.trade_id,
        side = EXCLUDED.side,
        size = EXCLUDED.size,
        avg_price = EXCLUDED.avg_price,
        -- Мерж дельт поверх snapshot (§12/задача 3): markPrice не в каждом пуше — сохраняем
        -- прежнее значение, если новое отсутствует.
        mark_price = COALESCE(EXCLUDED.mark_price, positions.mark_price),
        liq_price = EXCLUDED.liq_price,
        leverage = EXCLUDED.leverage,
        unrealised_pnl = EXCLUDED.unrealised_pnl,
        cur_realised_pnl = EXCLUDED.cur_realised_pnl,
        take_profit = EXCLUDED.take_profit,
        stop_loss = EXCLUDED.stop_loss,
        position_status = EXCLUDED.position_status,
        bybit_seq = EXCLUDED.bybit_seq,
        updated_at = now()
    `.execute(trx)

    await emitPositionUpsert(trx, channelId, push.symbol)
    notifyNeeded = true

    if (isFlat && tradeId) {
      // Полное закрытие (§11: size→0): закрыть #TR-x, освободить владение символом — обе явно,
      // как того требует бриф задачи (closeTrade сам по себе уже освобождает symbol_ownership
      // по tradeId, releaseSymbol здесь — идемпотентный no-op в норме, но гарантирует
      // освобождение и в фолбэк-ветке attributeSymbol, где символ мог остаться захваченным
      // другим путём). realized_pnl НЕ передаём сюда — единственный писатель этого поля в
      // live-режиме — applyExecutionPush (пересчёт по сумме exec_pnl), не угадываем его здесь.
      await closeTrade(trx, { tradeId })
      await releaseSymbol(trx, { channelId, symbol: push.symbol })

      const trade = await trx
        .selectFrom('trades')
        .select(['human_ref', 'realized_pnl'])
        .where('id', '=', tradeId)
        .executeTakeFirst()

      await trx
        .insertInto('domain_events')
        .values({
          type: 'position.close',
          aggregate: 'position',
          aggregate_id: `${channelId}:${push.symbol}`,
          payload: JSON.stringify({
            channelId,
            symbol: push.symbol,
            tradeRef: trade?.human_ref ?? null,
            realizedPnl: trade?.realized_pnl ?? '0',
          }),
        })
        .execute()

      shouldCancelAll = true
    }
  })

  if (shouldCancelAll) {
    // R8: снять висящие TP/SL-остатки символа. Вне транзакции — сетевой вызов биржи не держит
    // соединение БД (тот же приём, что и весь остальной сетевой код в rest-client.ts).
    await rest.cancelAll(push.symbol)
  }

  return notifyNeeded
}

/**
 * Применяет один пуш `execution.linear`: идемпотентная вставка `executions` по `bybit_exec_id`
 * (UNIQUE), атрибуция к ордеру/сделке/леге по `orderLinkId`, пересчёт `trades.realized_pnl` как
 * суммы `exec_pnl` всех исполнений сделки (единственный писатель этого поля в live-режиме).
 *
 * @returns true, если строка `executions` реально вставлена (false — дубль `bybit_exec_id`,
 *   повтор при реконнекте/редоставке, уже обработан раньше).
 */
export async function applyExecutionPush(db: Kysely<DB>, push: ExecutionPush): Promise<boolean> {
  let inserted = false

  await db.transaction().execute(async (trx) => {
    const order = push.orderLinkId
      ? await trx
          .selectFrom('orders')
          .select(['id', 'trade_id', 'leg_id'])
          .where('order_link_id', '=', push.orderLinkId)
          .executeTakeFirst()
      : undefined

    const row = await trx
      .insertInto('executions')
      .values({
        order_id: order?.id ?? null,
        trade_id: order?.trade_id ?? null,
        leg_id: order?.leg_id ?? null,
        bybit_exec_id: push.execId,
        order_link_id: push.orderLinkId,
        symbol: push.symbol,
        side: mapSide(push.side) ?? 'long', // execution всегда 'Buy'/'Sell' на бирже — 'long' здесь недостижим
        exec_qty: push.execQty,
        exec_price: push.execPrice,
        closed_size: push.closedSize,
        leaves_qty: push.leavesQty,
        exec_fee: push.execFee ?? '0',
        exec_pnl: push.execPnl ?? '0',
        exec_type: push.execType,
        is_maker: push.isMaker,
        exec_ts: push.execTime ? new Date(Number(push.execTime)) : new Date(),
      })
      .onConflict((oc) => oc.column('bybit_exec_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!row) return // дубль bybit_exec_id — уже обработан, не пересчитываем повторно
    inserted = true

    if (order?.trade_id) {
      const { rows } = await sql<{ total: string }>`
        SELECT COALESCE(SUM(exec_pnl), 0)::text AS total FROM executions WHERE trade_id = ${order.trade_id}::uuid
      `.execute(trx)
      await trx
        .updateTable('trades')
        .set({ realized_pnl: rows[0]?.total ?? '0', updated_at: new Date() })
        .where('id', '=', order.trade_id)
        .execute()
    }
  })

  return inserted
}

/**
 * Применяет один пуш `order.linear`: обновляет `orders.status`/`bybit_order_id` по `orderLinkId`,
 * публикует `order.resolved`. Ордер не найден локально (чужой/ещё не записан) — no-op, не ошибка.
 *
 * @returns true, если ордер найден, обновлён и `order.resolved` опубликован.
 */
export async function applyOrderPush(db: Kysely<DB>, push: OrderPush): Promise<boolean> {
  const status = mapOrderStatus(push.orderStatus)
  let notifyNeeded = false

  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('orders')
      .set({
        status,
        bybit_order_id: push.orderId,
        updated_at: new Date(),
        ...(status === 'filled' ? { filled_at: new Date() } : {}),
        ...(status === 'cancelled' ? { cancelled_at: new Date() } : {}),
      })
      .where('order_link_id', '=', push.orderLinkId)
      .returning(['id', 'channel_id', 'symbol', 'trade_id'])
      .executeTakeFirst()

    if (!updated) return // ордер этого движка не найден — чужой/гонка записи, не ошибка

    await trx
      .insertInto('domain_events')
      .values({
        type: 'order.resolved',
        aggregate: 'order',
        aggregate_id: updated.id,
        payload: JSON.stringify({
          channelId: updated.channel_id,
          tradeId: updated.trade_id,
          symbol: updated.symbol,
          orderLinkId: push.orderLinkId,
          bybitOrderId: push.orderId,
          status,
        }),
      })
      .execute()

    notifyNeeded = true
  })

  return notifyNeeded
}

// ---------------------------------------------------------------------------
// Класс: соединение, хендшейк, реконнект+реаутентификация, диспетчеризация пушей.
// ---------------------------------------------------------------------------

export interface BybitPrivateWsLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface BybitPrivateWsOptions {
  apiKey: string
  apiSecret: string
  network: Network
  db: Kysely<DB>
  rest: BybitPrivateWsRestClient
  log?: BybitPrivateWsLogger
}

/**
 * `BybitPrivateWs({apiKey, apiSecret, network, db, rest})` — подключается к приватному WS Bybit,
 * аутентифицируется, подписывается на position/order/execution/wallet, диспетчеризует каждый пуш
 * в соответствующий `apply*Push` (см. выше). Реконнект — экспоненциальный backoff, тот же паттерн,
 * что и `market-data/tickers-feed.ts` (задача 10): на каждый (ре)коннект — ПОЛНАЯ реаутентификация
 * (`op:auth`) и переподписка (`op:subscribe`), Bybit не переносит их между TCP-соединениями.
 */
export class BybitPrivateWs {
  private ws: WebSocket | null = null
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs = RECONNECT_BASE_MS
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private cachedEquity: string | null = null

  constructor(private readonly opts: BybitPrivateWsOptions) {}

  /** Последний известный totalEquity из пушей `wallet` (кэш, задача 3 — "опционально"; null до
   *  первого пуша). Настоящий рефреш-с-диска/периодический REST — зона задачи 4 (equity.ts). */
  get equity(): string | null {
    return this.cachedEquity
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
    this.ws?.close()
    this.ws = null
  }

  private connect(): void {
    if (this.stopped) return
    const url = WS_HOSTS[this.opts.network]
    const log = this.opts.log ?? console
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      log.log(`[private-ws] подключен к ${url}`)
      this.reconnectDelayMs = RECONNECT_BASE_MS
      this.authenticate()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.sendSafe({ op: 'ping' }), PING_INTERVAL_MS)
    })

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(String(event.data)).catch((err) => log.error('[private-ws] обработка пуша:', err))
    })

    // 'close' следует и за штатным, и за аварийным завершением — реконнект планируется только
    // там (тот же приём, что tickers-feed.ts), чтобы не задвоить таймер.
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      log.warn('[private-ws] ошибка соединения (ожидаю close для реконнекта)')
    })
  }

  /** `op:auth` (§11): `args=[apiKey, expires, signature]`, `expires=now+10000ms`. */
  private authenticate(): void {
    const expires = Date.now() + AUTH_EXPIRES_MS
    const signature = signWsAuth(this.opts.apiSecret, expires)
    this.sendSafe({ op: 'auth', args: [this.opts.apiKey, expires, signature] })
  }

  private subscribe(): void {
    this.sendSafe({ op: 'subscribe', args: SUBSCRIBE_TOPICS })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendSafe(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private async handleMessage(raw: string): Promise<void> {
    const log = this.opts.log ?? console

    const ack = parseOpAck(raw)
    if (ack) {
      if (ack.op === 'auth') {
        if (ack.success) {
          log.log('[private-ws] auth success')
          this.subscribe()
        } else {
          log.error(`[private-ws] auth ошибка: ${ack.retMsg ?? 'unknown'}`)
        }
      } else if (ack.op === 'subscribe') {
        if (ack.success) log.log('[private-ws] subscribe success')
        else log.error(`[private-ws] subscribe ошибка: ${ack.retMsg ?? 'unknown'}`)
      }
      // 'pong'/'ping' — не требуют реакции.
      return
    }

    const frame = parseFrame(raw)
    if (!frame) return

    let notifyNeeded = false
    switch (frame.topic) {
      case 'position':
        for (const item of frame.data) {
          const push = toPositionPush(item)
          if (push && (await applyPositionPush(this.opts.db, push, this.opts.rest))) notifyNeeded = true
        }
        break
      case 'execution':
        for (const item of frame.data) {
          const push = toExecutionPush(item)
          if (push) await applyExecutionPush(this.opts.db, push)
        }
        break
      case 'order':
        for (const item of frame.data) {
          const push = toOrderPush(item)
          if (push && (await applyOrderPush(this.opts.db, push))) notifyNeeded = true
        }
        break
      case 'wallet':
        for (const item of frame.data) {
          const push = toWalletPush(item)
          if (push?.totalEquity) this.cachedEquity = push.totalEquity
        }
        break
    }

    if (notifyNeeded) {
      // Тот же приём, что pipeline.ts/apply-tick.ts: NOTIFY сразу после коммита — будит
      // OutboxPublisher api немедленно, не дожидаясь его периодического опроса.
      await sql`SELECT pg_notify('domain_events', '')`.execute(this.opts.db)
    }
  }
}
