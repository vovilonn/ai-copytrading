import { sql, type Kysely } from 'kysely'
import { createDb, type DB } from 'api/db/database.js'

/**
 * Доступ к БД со стороны e2e: ожидание результата обработки, полный «трейс» сообщения и чистка
 * состояния тестовых каналов между сценариями.
 *
 * Читаем ту же боевую базу, что и стек (не copytrade_test): смысл прогона — увидеть, что делает
 * НАСТОЯЩИЙ движок в контейнере, а не поднять его копию. Поэтому все записи здесь ограничены
 * строками ТЕСТОВЫХ каналов (channel_id из TG_CHANNEL_OVERRIDES) — боевые каналы и их история
 * не трогаются ни одной командой этого модуля.
 */

/** Статусы, после которых пайплайн к сообщению больше не возвращается (msg_status, 001/004). */
const TERMINAL_STATUSES = ['executed', 'skipped', 'needs_review', 'noise', 'failed', 'archived'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminal(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

export interface MessageRow {
  id: string
  tgMessageId: number
  status: string
  statusReason: string | null
  method: string | null
  text: string
  aiSummary: string | null
  editCount: number
  hasMedia: boolean
  mediaKind: string | null
  groupedId: string | null
  replyToMsgId: number | null
  deleted: boolean
  receivedAt: Date
  updatedAt: Date
}

export interface ParseResultRow {
  parser: string
  route: string
  confidence: string
  reason: string | null
  needsVision: boolean
  intents: unknown
}

export interface ActionRow {
  id: string
  actionIndex: number
  type: string
  status: string
  symbol: string | null
  side: string | null
  method: string
  skipReason: string | null
  detail: string | null
  pct: string | null
  params: unknown
  tradeId: string | null
}

export interface TradeRow {
  id: string
  humanRef: string
  symbol: string
  side: string
  status: string
  size: string
  initialSize: string | null
  avgEntry: string | null
  leverage: string | null
  realizedPnl: string
  needsReview: boolean
}

export interface OrderRow {
  orderLinkId: string
  bybitOrderId: string | null
  symbol: string
  purpose: string
  side: string
  orderType: string
  reduceOnly: boolean
  qty: string | null
  price: string | null
  status: string
  retCode: number | null
  retMsg: string | null
}

export interface PositionRow {
  symbol: string
  side: string | null
  size: string
  avgPrice: string | null
  stopLoss: string | null
  takeProfit: string | null
  leverage: string | null
  unrealisedPnl: string | null
}

export interface AiCallRow {
  model: string
  latencyMs: number
  httpStatus: number | null
  cacheHit: boolean
  escalated: boolean
  costUsd: string
  error: string | null
}

export interface MessageTrace {
  message: MessageRow
  parseResults: ParseResultRow[]
  actions: ActionRow[]
  trades: TradeRow[]
  orders: OrderRow[]
  positions: PositionRow[]
  aiCalls: AiCallRow[]
}

export function connect(databaseUrl: string): Kysely<DB> {
  return createDb(databaseUrl)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ждёт, пока сообщение (а) вообще появится в БД (это работа tg-ingest) и (б) дойдёт до
 * терминального статуса (это работа engine). Различать две стадии важно для диагностики: «не
 * доехало до БД» — умер ingest/нет сети Telegram, «висит в received» — умер/занят engine.
 */
export async function waitForProcessed(
  db: Kysely<DB>,
  channelId: number,
  tgMessageId: number,
  opts: { ingestTimeoutMs?: number; processTimeoutMs?: number; intervalMs?: number } = {},
): Promise<MessageRow> {
  const ingestTimeoutMs = opts.ingestTimeoutMs ?? 60_000
  const processTimeoutMs = opts.processTimeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 500

  const ingestDeadline = Date.now() + ingestTimeoutMs
  let row = await findMessage(db, channelId, tgMessageId)
  while (!row) {
    if (Date.now() >= ingestDeadline) {
      throw new Error(
        `e2e: сообщение ${tgMessageId} канала ${channelId} не появилось в БД за ${ingestTimeoutMs} мс — проверьте tg-ingest (docker compose logs tg-ingest)`,
      )
    }
    await sleep(intervalMs)
    row = await findMessage(db, channelId, tgMessageId)
  }

  const processDeadline = Date.now() + processTimeoutMs
  while (!isTerminal(row.status)) {
    if (Date.now() >= processDeadline) {
      throw new Error(
        `e2e: сообщение ${tgMessageId} застряло в статусе '${row.status}' дольше ${processTimeoutMs} мс — проверьте engine (docker compose logs engine)`,
      )
    }
    await sleep(intervalMs)
    row = (await findMessage(db, channelId, tgMessageId))!
  }
  return row
}

export async function findMessage(db: Kysely<DB>, channelId: number, tgMessageId: number): Promise<MessageRow | null> {
  const row = await db
    .selectFrom('messages')
    .select([
      'id',
      'tg_message_id',
      'status',
      'status_reason',
      'method',
      'text',
      'ai_summary',
      'edit_count',
      'has_media',
      'media_kind',
      'grouped_id',
      'reply_to_msg_id',
      'deleted',
      'received_at',
      'updated_at',
    ])
    .where('channel_id', '=', channelId)
    .where('tg_message_id', '=', tgMessageId)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: row.id,
    tgMessageId: Number(row.tg_message_id),
    status: row.status,
    statusReason: row.status_reason,
    method: row.method,
    text: row.text,
    aiSummary: row.ai_summary,
    editCount: row.edit_count,
    hasMedia: row.has_media,
    mediaKind: row.media_kind,
    groupedId: row.grouped_id,
    replyToMsgId: row.reply_to_msg_id === null ? null : Number(row.reply_to_msg_id),
    deleted: row.deleted,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  }
}

/** Полная картина по сообщению: разбор, действия, сделки, ордера, позиции, вызовы модели. */
export async function trace(db: Kysely<DB>, channelId: number, message: MessageRow): Promise<MessageTrace> {
  const parseResults = await db
    .selectFrom('parse_results')
    .select(['parser', 'route', 'confidence', 'reason', 'needs_vision', 'intents'])
    .where('message_id', '=', message.id)
    .orderBy('created_at', 'asc')
    .execute()

  const actions = await db
    .selectFrom('actions')
    .select([
      'id',
      'action_index',
      'type',
      'status',
      'symbol',
      'side',
      'method',
      'skip_reason',
      'detail',
      'pct',
      'params',
      'trade_id',
    ])
    .where('message_id', '=', message.id)
    .orderBy('action_index', 'asc')
    .execute()

  const tradeIds = [...new Set(actions.map((a) => a.trade_id).filter((id): id is string => id !== null))]
  const trades = tradeIds.length
    ? await db
        .selectFrom('trades')
        .select([
          'id',
          'human_ref',
          'symbol',
          'side',
          'status',
          'size',
          'initial_size',
          'avg_entry',
          'leverage',
          'realized_pnl',
          'needs_review',
        ])
        .where('id', 'in', tradeIds)
        .execute()
    : []

  const orders = tradeIds.length
    ? await db
        .selectFrom('orders')
        .select([
          'order_link_id',
          'bybit_order_id',
          'symbol',
          'purpose',
          'side',
          'order_type',
          'reduce_only',
          'qty',
          'price',
          'status',
          'ret_code',
          'ret_msg',
        ])
        .where('trade_id', 'in', tradeIds)
        .orderBy('created_at', 'asc')
        .execute()
    : []

  const symbols = [...new Set(actions.map((a) => a.symbol).filter((s): s is string => s !== null))]
  const positions = symbols.length ? await positionsOf(db, channelId, symbols) : []

  const aiCalls = await sql<{
    model: string
    latency_ms: number
    http_status: number | null
    cache_hit: boolean
    escalated: boolean
    cost_usd: string
    error: string | null
  }>`SELECT model, latency_ms, http_status, cache_hit, escalated, cost_usd, error
       FROM ai_calls WHERE message_id = ${message.id} ORDER BY created_at ASC`.execute(db)

  return {
    message,
    parseResults: parseResults.map((p) => ({
      parser: p.parser,
      route: p.route,
      confidence: p.confidence,
      reason: p.reason,
      needsVision: p.needs_vision,
      intents: p.intents,
    })),
    actions: actions.map((a) => ({
      id: a.id,
      actionIndex: a.action_index,
      type: a.type,
      status: a.status,
      symbol: a.symbol,
      side: a.side,
      method: a.method,
      skipReason: a.skip_reason,
      detail: a.detail,
      pct: a.pct,
      params: a.params,
      tradeId: a.trade_id,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      humanRef: t.human_ref,
      symbol: t.symbol,
      side: t.side,
      status: t.status,
      size: t.size,
      initialSize: t.initial_size,
      avgEntry: t.avg_entry,
      leverage: t.leverage,
      realizedPnl: t.realized_pnl,
      needsReview: t.needs_review,
    })),
    orders: orders.map((o) => ({
      orderLinkId: o.order_link_id,
      bybitOrderId: o.bybit_order_id,
      symbol: o.symbol,
      purpose: o.purpose,
      side: o.side,
      orderType: o.order_type,
      reduceOnly: o.reduce_only,
      qty: o.qty,
      price: o.price,
      status: o.status,
      retCode: o.ret_code,
      retMsg: o.ret_msg,
    })),
    positions,
    aiCalls: aiCalls.rows.map((c) => ({
      model: c.model,
      latencyMs: c.latency_ms,
      httpStatus: c.http_status,
      cacheHit: c.cache_hit,
      escalated: c.escalated,
      costUsd: c.cost_usd,
      error: c.error,
    })),
  }
}

export async function positionsOf(db: Kysely<DB>, channelId: number, symbols?: string[]): Promise<PositionRow[]> {
  let query = db
    .selectFrom('positions')
    .select(['symbol', 'side', 'size', 'avg_price', 'stop_loss', 'take_profit', 'leverage', 'unrealised_pnl'])
    .where('channel_id', '=', channelId)
  if (symbols && symbols.length > 0) query = query.where('symbol', 'in', symbols)
  const rows = await query.orderBy('symbol', 'asc').execute()
  return rows.map((p) => ({
    symbol: p.symbol,
    side: p.side,
    size: p.size,
    avgPrice: p.avg_price,
    stopLoss: p.stop_loss,
    takeProfit: p.take_profit,
    leverage: p.leverage,
    unrealisedPnl: p.unrealised_pnl,
  }))
}

/** Сделки канала (при необходимости — по символам): проверки «сделка ушла не в тот канал». */
export async function tradesOf(db: Kysely<DB>, channelId: number, symbols?: string[]): Promise<TradeRow[]> {
  let query = db
    .selectFrom('trades')
    .select(['id', 'human_ref', 'symbol', 'side', 'status', 'size', 'initial_size', 'avg_entry', 'leverage', 'realized_pnl', 'needs_review'])
    .where('channel_id', '=', channelId)
  if (symbols && symbols.length > 0) query = query.where('symbol', 'in', symbols)
  const rows = await query.orderBy('seq', 'asc').execute()
  return rows.map((t) => ({
    id: t.id,
    humanRef: t.human_ref,
    symbol: t.symbol,
    side: t.side,
    status: t.status,
    size: t.size,
    initialSize: t.initial_size,
    avgEntry: t.avg_entry,
    leverage: t.leverage,
    realizedPnl: t.realized_pnl,
    needsReview: t.needs_review,
  }))
}

/** Инструмент из локального кэша (таблица instruments) — шаг цены/лота для генерации текстов. */
export interface InstrumentInfo {
  symbol: string
  tickSize: string
  qtyStep: string
  minNotional: string
  maxLeverage: string
  status: string
}

export async function instrument(db: Kysely<DB>, network: string, symbol: string): Promise<InstrumentInfo | null> {
  const row = await db
    .selectFrom('instruments')
    .select(['symbol', 'tick_size', 'qty_step', 'min_notional', 'max_leverage', 'status'])
    .where('network', '=', network as 'demo' | 'testnet' | 'mainnet')
    .where('symbol', '=', symbol)
    .executeTakeFirst()
  if (!row) return null
  return {
    symbol: row.symbol,
    tickSize: row.tick_size,
    qtyStep: row.qty_step,
    minNotional: row.min_notional,
    maxLeverage: row.max_leverage,
    status: row.status,
  }
}

/** Сообщения, которые движок ещё не обработал (по всем каналам) — гейт готовности в doctor. */
export async function pendingMessages(db: Kysely<DB>): Promise<{ channelId: number; status: string; count: number }[]> {
  const rows = await db
    .selectFrom('messages')
    .select(['channel_id', 'status', db.fn.countAll<string>().as('count')])
    .where('status', 'in', ['received', 'normalized', 'parsed', 'decided', 'executing'])
    .groupBy(['channel_id', 'status'])
    .execute()
  return rows.map((r) => ({ channelId: Number(r.channel_id), status: r.status, count: Number(r.count) }))
}

export interface ChannelState {
  id: number
  ord: number
  key: string
  title: string | null
  adapterId: string
  status: string
  lastSeenMessageId: number
  enabled: boolean
  tradeSize: string
  maxLeverage: string
  maxSymbolNotional: string | null
  noSlPolicy: string
  defaultLeverage: string | null
}

export async function channelState(db: Kysely<DB>, channelId: number): Promise<ChannelState | null> {
  const row = await db
    .selectFrom('channels')
    .innerJoin('channel_settings', 'channel_settings.channel_id', 'channels.id')
    .select([
      'channels.id',
      'channels.ord',
      'channels.key',
      'channels.title',
      'channels.adapter_id',
      'channels.status',
      'channels.last_seen_message_id',
      'channel_settings.enabled',
      'channel_settings.trade_size',
      'channel_settings.max_leverage',
      'channel_settings.max_symbol_notional',
      'channel_settings.no_sl_policy',
      'channel_settings.default_leverage',
    ])
    .where('channels.id', '=', channelId)
    .executeTakeFirst()
  if (!row) return null
  return {
    id: Number(row.id),
    ord: row.ord,
    key: row.key,
    title: row.title,
    adapterId: row.adapter_id,
    status: row.status,
    lastSeenMessageId: Number(row.last_seen_message_id),
    enabled: row.enabled,
    tradeSize: row.trade_size,
    maxLeverage: row.max_leverage,
    maxSymbolNotional: row.max_symbol_notional,
    noSlPolicy: row.no_sl_policy,
    defaultLeverage: row.default_leverage,
  }
}

export interface TestProfile {
  enabled: boolean
  tradeSize: string
  maxLeverage: string
  /**
   * Потолок нотионала на символ. Без него сигнал с «риск 2%» на equity ~50k demo даёт нотионал
   * порядка 20 000 USDT (sizing.ts: risk×equity/d) — прогон стал бы неоправданно тяжёлым, а
   * ошибка в сценарии — дорогой. Это штатная настройка канала (channel_settings.max_symbol_notional),
   * а не тестовый хак: движок применяет её тем же кодом, что и в проде.
   */
  maxSymbolNotional: string
  noSlPolicy: string
}

export async function applyTestProfile(db: Kysely<DB>, channelId: number, profile: TestProfile): Promise<void> {
  await db
    .updateTable('channel_settings')
    .set({
      enabled: profile.enabled,
      trade_size: profile.tradeSize,
      max_leverage: profile.maxLeverage,
      max_symbol_notional: profile.maxSymbolNotional,
      no_sl_policy: profile.noSlPolicy,
      updated_at: new Date(),
    })
    .where('channel_id', '=', channelId)
    .execute()
}

/** Курсор бэкфилла: с какого tg_message_id tg-ingest продолжит читать канал. */
export async function setCursor(db: Kysely<DB>, channelId: number, tgMessageId: number): Promise<void> {
  await db
    .updateTable('channels')
    .set({ last_seen_message_id: tgMessageId, updated_at: new Date() })
    .where('id', '=', channelId)
    .execute()
}

export interface PurgeSummary {
  messages: number
  actions: number
  trades: number
  orders: number
  positions: number
}

/**
 * Полная чистка следов ТЕСТОВОГО канала. Порядок продиктован внешними ключами и одной
 * циклической связью: actions.trade_id → trades.id и trades.opened_action_id → actions.id —
 * поэтому ссылки сделки на action/сообщение сначала обнуляются, и только потом удаляются строки.
 *
 * Зачем вообще чистить: symbol_ownership держит «символ занят каналом», и без сброса второй
 * сценарий по тому же символу получил бы skipped(symbol_busy) вместо входа. Плюс чистая БД
 * делает отчёт читаемым — в трейсе видно только то, что произошло в этом прогоне.
 */
export async function purgeChannel(db: Kysely<DB>, channelId: number, channelOrd?: number): Promise<PurgeSummary> {
  return db.transaction().execute(async (trx) => {
    const tradeIds = (await trx.selectFrom('trades').select('id').where('channel_id', '=', channelId).execute()).map((r) => r.id)
    const messageIds = (await trx.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute()).map(
      (r) => r.id,
    )

    // Исполнения сносим и по сделке, и по ОРДЕРУ: реконсиляция может записать исполнение с
    // order_id, но без trade_id (филл, который ещё не атрибутирован сделке) — такая строка
    // держала бы FK на orders и роняла следующий DELETE.
    const orderIds = (await trx.selectFrom('orders').select('id').where('channel_id', '=', channelId).execute()).map((r) => r.id)
    if (tradeIds.length > 0 || orderIds.length > 0) {
      await trx
        .deleteFrom('executions')
        .where((eb) =>
          eb.or([
            ...(tradeIds.length > 0 ? [eb('trade_id', 'in', tradeIds)] : []),
            ...(orderIds.length > 0 ? [eb('order_id', 'in', orderIds)] : []),
          ]),
        )
        .execute()
    }
    const orders = await trx.deleteFrom('orders').where('channel_id', '=', channelId).executeTakeFirst()
    if (tradeIds.length > 0) {
      await trx.deleteFrom('trade_legs').where('trade_id', 'in', tradeIds).execute()
    }
    await trx.deleteFrom('symbol_ownership').where('channel_id', '=', channelId).execute()
    const positions = await trx.deleteFrom('positions').where('channel_id', '=', channelId).executeTakeFirst()

    // Разрыв цикла FK перед удалением: trades ссылается на actions/messages, которые уйдут ниже.
    await trx
      .updateTable('trades')
      .set({ opened_action_id: null, opened_msg_id: null })
      .where('channel_id', '=', channelId)
      .execute()

    const actions = await trx.deleteFrom('actions').where('channel_id', '=', channelId).executeTakeFirst()
    const trades = await trx.deleteFrom('trades').where('channel_id', '=', channelId).executeTakeFirst()

    if (messageIds.length > 0) {
      // ai_calls/domain_events не типизированы в DB-интерфейсе (api/db/database.ts) — сырой SQL.
      await sql`DELETE FROM ai_calls WHERE message_id = ANY(${messageIds}::uuid[])`.execute(trx)
      await sql`DELETE FROM domain_events WHERE aggregate_id = ANY(${messageIds}::text[])`.execute(trx)
    }
    // messages каскадом уносит parse_results и message_media (001_initial.ts).
    const messages = await trx.deleteFrom('messages').where('channel_id', '=', channelId).executeTakeFirst()
    await sql`DELETE FROM processed_messages WHERE channel_id = ${channelId}`.execute(trx)

    // «Осиротевшие» исполнения: приватный WS вставляет строку execution РАНЬШЕ, чем коммитится
    // транзакция пайплайна с её ордером (order_id/trade_id тогда NULL — известная гонка, её
    // штатно чинит периодическая реконсиляция). Удаление выше их не задевает — они не ссылаются
    // ни на ордер, ни на сделку, и после чистки чинить их уже нечем: строки orders больше нет.
    // Ловим по префиксу orderLinkId движка: `K<ord>-…` (order-link-id.ts, live-режим).
    if (channelOrd !== undefined) {
      const prefix = `K${String(channelOrd).padStart(2, '0')}-`
      await sql`DELETE FROM executions WHERE order_link_id LIKE ${prefix + '%'}`.execute(trx)
    }

    return {
      messages: Number(messages.numDeletedRows ?? 0),
      actions: Number(actions.numDeletedRows ?? 0),
      trades: Number(trades.numDeletedRows ?? 0),
      orders: Number(orders.numDeletedRows ?? 0),
      positions: Number(positions.numDeletedRows ?? 0),
    }
  })
}
