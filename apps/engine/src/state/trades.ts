import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Side, TradeStatus, LegKind, LegStatus } from 'shared/domain.js'

// Состояние сделок (design spec: trades/trade_legs/symbol_ownership, research
// backend-architecture.md §2/§"Инициатор переходов"). Все функции принимают `tx: Kysely<DB>` —
// либо саму БД, либо `Transaction<DB>` (подкласс Kysely<DB>, см. kysely.d.ts): вызывающая
// сторона (будущий reconciler/пайплайн исполнения) оборачивает несколько вызовов в одну
// транзакцию через `db.transaction().execute(async (trx) => {...})`, как уже принято в
// apps/tg-ingest/src/repository.ts.

export interface AcquireSymbolParams {
  channelId: number
  symbol: string
  tradeId: string
}

/**
 * Атомарный захват символа ВНУТРИ канала (решение #1: субаккаунт на канал + "один символ —
 * один канал/сделка" внутри канала). Уникальность — частичный индекс
 * `uq_symbol_active_per_channel` на (channel_id, symbol) WHERE released_at IS NULL (миграция
 * 001). `ON CONFLICT ... WHERE released_at IS NULL DO NOTHING` целится в этот же частичный
 * индекс — гонка двух сообщений одного канала за один символ разрешается атомарно на уровне
 * БД (SELECT+INSERT из JS был бы TOCTOU при параллельных вызовах).
 *
 * @returns true — захватили; false — символ уже занят активной (release_at IS NULL) записью
 * внутри ЭТОГО канала. Разные каналы могут держать один и тот же символ одновременно —
 * уникальность именно по паре (channel_id, symbol), не по одному symbol.
 */
export async function acquireSymbol(tx: Kysely<DB>, params: AcquireSymbolParams): Promise<boolean> {
  const row = await tx
    .insertInto('symbol_ownership')
    .values({
      symbol: params.symbol,
      channel_id: params.channelId,
      trade_id: params.tradeId,
    })
    .onConflict((oc) => oc.columns(['channel_id', 'symbol']).where('released_at', 'is', null).doNothing())
    .returning('id')
    .executeTakeFirst()

  return row !== undefined
}

export interface ReleaseSymbolParams {
  channelId: number
  symbol: string
}

/**
 * Освобождает активное владение символом внутри канала (released_at = now()).
 * Фильтр `WHERE released_at IS NULL` обязателен: без него UPDATE задел бы и уже освобождённые
 * исторические записи того же (channel_id, symbol) — испортил бы released_at прошлых сделок.
 * Нет активной записи (уже освобождена/не захватывалась) — no-op, не ошибка.
 */
export async function releaseSymbol(tx: Kysely<DB>, params: ReleaseSymbolParams): Promise<void> {
  await tx
    .updateTable('symbol_ownership')
    .set({ released_at: new Date() })
    .where('channel_id', '=', params.channelId)
    .where('symbol', '=', params.symbol)
    .where('released_at', 'is', null)
    .execute()
}

export interface OpenTradeParams {
  channelId: number
  symbol: string
  side: Side
  /** По умолчанию 'pending' — переход в 'open' делается по факту первого филла с биржи
   *  (research backend-architecture.md: "pending→open — по первому филлу entry-леги"),
   *  не в момент создания записи. */
  status?: TradeStatus
  openedActionId?: string | null
  openedMsgId?: string | null
  leverage?: string | null
  initialSize?: string | null
  openedAt?: Date | null
}

export interface OpenTradeResult {
  tradeId: string
  humanRef: string
  seq: number
}

/**
 * Создаёт запись trades. ГРАБЛЯ Ф0 (task-2-report.md): `human_ref` ('TR-'||seq) и `seq`
 * ОБЯЗАНЫ выводиться из ОДНОГО вызова `nextval('trade_ref_seq')` — два отдельных вызова
 * дают РАЗНЫЕ числа и рассогласуют human_ref/seq. CTE `WITH s AS (SELECT nextval(...) AS n)`
 * гарантирует единственный вызов nextval() внутри одного SQL-запроса (тот же приём,
 * что задокументирован в migrations/001_initial.ts прямо над CREATE SEQUENCE).
 */
export async function openTrade(tx: Kysely<DB>, params: OpenTradeParams): Promise<OpenTradeResult> {
  const status = params.status ?? 'pending'

  const { rows } = await sql<{ id: string; human_ref: string; seq: number }>`
    WITH s AS (SELECT nextval('trade_ref_seq') AS n)
    INSERT INTO trades (
      human_ref, seq, channel_id, symbol, side, status,
      opened_action_id, opened_msg_id, leverage, initial_size, opened_at
    )
    SELECT
      'TR-' || s.n, s.n, ${params.channelId}::bigint, ${params.symbol}::text, ${params.side}::side_t,
      ${status}::trade_status,
      ${params.openedActionId ?? null}::uuid, ${params.openedMsgId ?? null}::uuid,
      ${params.leverage ?? null}::numeric, ${params.initialSize ?? null}::numeric,
      ${params.openedAt ?? null}::timestamptz
    FROM s
    RETURNING id, human_ref, seq
  `.execute(tx)

  const row = rows[0]
  if (!row) throw new Error('openTrade: INSERT ... RETURNING не вернул строку')

  return { tradeId: row.id, humanRef: row.human_ref, seq: row.seq }
}

export interface AddLegParams {
  tradeId: string
  legIndex: number
  kind: LegKind
  sourceMessageId?: string | null
  sourceActionId?: string | null
  /** Денежное поле — строка (NUMERIC), не JS number (см. risk/sizing.ts, risk/leverage.ts). */
  requestedQty: string
  status?: LegStatus
}

export interface AddLegResult {
  legId: string
}

/**
 * Создаёт лег сделки (один вход/добор/цель TP = одна лега, решение #4). Идемпотентен по
 * (trade_id, leg_index) (UNIQUE-ограничение trade_legs_trade_id_leg_index_key, миграция 001):
 * повторный вызов с теми же координатами (ретрай/реконнект обработки того же сообщения) не
 * плодит вторую строку и не падает unique_violation, а возвращает id уже существующей леги —
 * симметрично acquireSymbol выше, тот же принцип идемпотентности исполнения.
 */
export async function addLeg(tx: Kysely<DB>, params: AddLegParams): Promise<AddLegResult> {
  const inserted = await tx
    .insertInto('trade_legs')
    .values({
      trade_id: params.tradeId,
      leg_index: params.legIndex,
      kind: params.kind,
      source_message_id: params.sourceMessageId ?? null,
      source_action_id: params.sourceActionId ?? null,
      requested_qty: params.requestedQty,
      status: params.status ?? 'pending',
    })
    .onConflict((oc) => oc.columns(['trade_id', 'leg_index']).doNothing())
    .returning('id')
    .executeTakeFirst()

  if (inserted) return { legId: inserted.id }

  const existing = await tx
    .selectFrom('trade_legs')
    .select('id')
    .where('trade_id', '=', params.tradeId)
    .where('leg_index', '=', params.legIndex)
    .executeTakeFirstOrThrow()

  return { legId: existing.id }
}

export interface CloseTradeParams {
  tradeId: string
  /** 'closed' (по умолчанию) или 'cancelled' — по умолчанию нормальное закрытие. */
  status?: Extract<TradeStatus, 'closed' | 'cancelled'>
  closedAt?: Date
  realizedPnl?: string
  feesPaid?: string
  isWin?: boolean | null
}

/**
 * Закрывает сделку: переводит trades.status в 'closed'/'cancelled' и освобождает
 * symbol_ownership (research backend-architecture.md §"Инициатор переходов": "→closed —
 * position.size→0 (тогда же symbol_ownership.released_at=now()...)"). Освобождение ключуется
 * по trade_id (не по channel_id/symbol) — эта связь уже есть в самой строке symbol_ownership
 * (FK на trades), вызывающему коду не нужно повторно передавать channelId/symbol.
 */
export async function closeTrade(tx: Kysely<DB>, params: CloseTradeParams): Promise<void> {
  const closedAt = params.closedAt ?? new Date()

  await tx
    .updateTable('trades')
    .set({
      status: params.status ?? 'closed',
      closed_at: closedAt,
      ...(params.realizedPnl !== undefined ? { realized_pnl: params.realizedPnl } : {}),
      ...(params.feesPaid !== undefined ? { fees_paid: params.feesPaid } : {}),
      ...(params.isWin !== undefined ? { is_win: params.isWin } : {}),
    })
    .where('id', '=', params.tradeId)
    .execute()

  await tx
    .updateTable('symbol_ownership')
    .set({ released_at: closedAt })
    .where('trade_id', '=', params.tradeId)
    .where('released_at', 'is', null)
    .execute()
}
