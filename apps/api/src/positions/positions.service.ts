import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import type { Side } from 'shared/domain.js'
import type { ChannelPnlDto, ClosedTradeDto, PositionDto, PositionStatsDto } from 'shared/dto.js'
import { formatDecimal, formatWinRate } from 'shared/numbers.js'
import { DatabaseService } from '../db/database.service.js'
import { escapeLikePattern } from '../db/like-escape.js'

/** Query-параметры GET /api/positions (task-8-brief.md) — все опциональны, отсутствие/'all' = без фильтра. */
export interface PositionsFilter {
  channel?: string
  side?: string
  margin?: string
  q?: string
  /** Размер страницы — clamp'ится в [1, MAX_LIMIT], по умолчанию DEFAULT_LIMIT (та же keyset-
   *  конвенция, что и ActionsFilter — apps/api/src/actions/actions.service.ts). */
  limit?: string
  /** Keyset-курсор пагинации — синтетический id `${channelId}:${symbol}` ранее полученной строки
   *  (см. PositionDto.id): отдаёт строки СТРОГО ПОСЛЕ неё в порядке opened_at DESC, channel_id DESC,
   *  symbol DESC. Ключ — СТАБИЛЬНЫЙ trades.opened_at (не volatile positions.updated_at, который
   *  бампается mark-тиками — адверсариал-ревью F6). У positions нет одноколоночного PK (составной
   *  (channel_id, symbol)), поэтому курсор — пара-ключ, а не uuid. */
  before?: string
}

/** Query-параметры GET /api/positions/history (Task 2) — закрытые/отменённые сделки. */
export interface ClosedTradesFilter {
  channel?: string
  /** 'closed' (дефолт) | 'cancelled' | 'all'. */
  status?: string
  limit?: string
  /** Keyset-курсор — human_ref (tradeRef, напр. 'TR-1042') ранее полученной строки. Именно
   *  human_ref, а не trades.id (uuid): ClosedTradeDto отдаёт наружу только tradeRef, поэтому
   *  клиент может продолжить страницу лишь по нему (human_ref UNIQUE — валидный тай-брейкер). */
  before?: string
}

const SIDES: ReadonlySet<string> = new Set<Side>(['long', 'short'])
const MARGIN_MODES: ReadonlySet<string> = new Set(['cross', 'isolated'])

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Clamp тот же приём, что и в actions.service.ts — некорректное/отсутствующее значение тихо
 *  откатывается к дефолту, а не 400-ит запрос. */
function clampLimit(raw: string | undefined): number {
  const n = raw !== undefined ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.trunc(n), MAX_LIMIT)
}

/** Курсор positions — синтетический `${channelId}:${symbol}` (см. PositionDto.id). symbol'ы
 *  Bybit — заглавные буквенно-цифровые (BTCUSDT, 1000PEPEUSDT), двоеточий не содержат, поэтому
 *  режем по ПЕРВОМУ ':'. Невалидный курсор → null (тихо игнорируется вызывающим, как мусорный
 *  before у actions). */
function parsePositionCursor(before: string): { channelId: number; symbol: string } | null {
  const idx = before.indexOf(':')
  if (idx <= 0) return null
  const channelId = Number(before.slice(0, idx))
  const symbol = before.slice(idx + 1)
  if (!Number.isFinite(channelId) || symbol.length === 0) return null
  return { channelId, symbol }
}

/** Число NUMERIC-строки для UI-агрегатов (сумм/ROI) — не денежный домен engine (там Decimal),
 *  а форматированная витрина: погрешность double на этих величинах ниже точности отображения
 *  ($ с 2 знаками/% с 1 знаком), тот же приём, что и formatNumeric в channels.service.ts. */
function toNumber(value: string | null): number {
  return value !== null ? Number(value) : 0
}

/** Нотионал позиции — по mark_price (design/project/Admin.dc.html: p.value = size*mark), с
 *  фолбэком на avg_price: живой тикер-фид ещё не подключён (задача 10), в Ф1 mark_price==
 *  avg_price на момент открытия (DryRunAdapter). */
function notionalOf(size: string, markPrice: string | null, avgPrice: string | null): number {
  const price = markPrice ?? avgPrice ?? '0'
  return Math.abs(toNumber(size)) * toNumber(price)
}

/** Начальная маржа. positions.position_im в Ф1 всегда null (DryRunAdapter её не пишет, см.
 *  комментарий над таблицей positions в apps/api/src/db/database.ts) — считаем сами как
 *  notional/leverage, тот же способ, что design mock (margin = value/lev). */
function marginOf(size: string, markPrice: string | null, avgPrice: string | null, positionIm: string | null, leverage: string | null): number {
  if (positionIm !== null) return toNumber(positionIm)
  const notional = notionalOf(size, markPrice, avgPrice)
  const lev = toNumber(leverage)
  return lev > 0 ? notional / lev : notional
}

/** unrealised_pnl обновляется живым тиком mark price (задача 10, apps/engine/src/market-data/
 *  apply-tick.ts) — здесь просто парсим уже посчитанную NUMERIC-строку в число для витрины.
 *  0 остаётся только пока по позиции ещё не пришёл ни один тик (mark_price/unrealised_pnl всё
 *  ещё null сразу после открытия) — это переходное состояние, а не гэп фазы. */
function pnlOf(unrealisedPnl: string | null): number {
  return toNumber(unrealisedPnl)
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function signedMoney(n: number): string {
  const sign = n >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function signedPct(n: number): string {
  const sign = n >= 0 ? '+' : '-'
  return `${sign}${Math.abs(n).toFixed(1)}%`
}

function computeRoi(pnl: number, margin: number): string {
  if (margin <= 0) return signedPct(0)
  return signedPct((pnl / margin) * 100)
}

interface PositionQueryRow {
  symbol: string
  side: Side | null
  size: string
  avg_price: string | null
  mark_price: string | null
  liq_price: string | null
  leverage: string | null
  unrealised_pnl: string | null
  position_im: string | null
  take_profit: string | null
  stop_loss: string | null
  channel_id: number
  channel_title: string | null
  channel_key: string
  human_ref: string | null
  margin_mode: string | null
}

function toPositionDto(row: PositionQueryRow): PositionDto {
  const pnl = pnlOf(row.unrealised_pnl)
  const margin = marginOf(row.size, row.mark_price, row.avg_price, row.position_im, row.leverage)
  const channelName = row.channel_title ?? row.channel_key

  return {
    id: `${row.channel_id}:${row.symbol}`,
    symbol: row.symbol,
    // side_t nullable в схеме, но при size<>0 её всегда выставляет handleEntrySignal
    // (apps/engine/src/pipeline.ts) вместе с size — 'long' здесь чисто защитный дефолт.
    side: row.side ?? 'long',
    size: formatDecimal(row.size),
    entry: row.avg_price !== null ? formatDecimal(row.avg_price) : '0',
    mark: row.mark_price !== null ? formatDecimal(row.mark_price) : row.avg_price !== null ? formatDecimal(row.avg_price) : '0',
    liq: row.liq_price !== null ? formatDecimal(row.liq_price) : null,
    unrealisedPnl: signedMoney(pnl),
    roi: computeRoi(pnl, margin),
    tp: row.take_profit !== null ? formatDecimal(row.take_profit) : null,
    sl: row.stop_loss !== null ? formatDecimal(row.stop_loss) : null,
    leverage: `${row.leverage !== null ? formatDecimal(row.leverage) : '0'}x`,
    marginMode: (row.margin_mode ?? 'cross').toLowerCase() === 'isolated' ? 'Isolated' : 'Cross',
    source: channelName,
    tradeRef: row.human_ref ? `#${row.human_ref}` : null,
    channelId: row.channel_id,
  }
}

interface ClosedTradeQueryRow {
  id: string
  human_ref: string
  channel_id: number
  channel_title: string | null
  channel_key: string
  symbol: string
  side: Side
  avg_entry: string | null
  realized_pnl: string
  is_win: boolean | null
  leverage: string | null
  status: 'closed' | 'cancelled'
  opened_at: Date | null
  // COALESCE(closed_at, updated_at) — cancelled-сделки, отменённые в pipeline.ts (status без
  // closed_at), имеют closed_at=NULL; updated_at всегда есть → ключ keyset/DTO никогда не null.
  close_key: Date
  exit_price: string | null
  close_action: string | null
}

/** Причина закрытия из последнего закрывающего action.type (см. mapCloseReason ниже). */
function mapCloseReason(status: 'closed' | 'cancelled', closeAction: string | null): ClosedTradeDto['closeReason'] {
  // 'cancelled' — неисполнившаяся лимитка, отдельный бейдж, приоритетнее любого action'а
  // (у отменённой сделки закрывающих действий обычно нет вовсе).
  if (status === 'cancelled') return 'cancelled'
  switch (closeAction) {
    case 'sl_hit':
      return 'sl'
    case 'tp_hit':
      return 'tp'
    case 'close':
    case 'partial_close':
    case 'close_all':
      return 'manual'
    // Ликвидации отдельного action_type в enum нет (shared/domain.ts) — не выдумываем; если
    // закрывающего действия не нашлось (напр. закрытие только реконсилером) → null.
    default:
      return null
  }
}

function toClosedTradeDto(row: ClosedTradeQueryRow): ClosedTradeDto {
  const openedMs = row.opened_at !== null ? row.opened_at.getTime() : null
  const closedMs = row.close_key.getTime()
  return {
    tradeRef: row.human_ref,
    channelId: row.channel_id,
    channelTitle: row.channel_title ?? row.channel_key,
    symbol: row.symbol,
    side: row.side,
    avgEntry: row.avg_entry !== null ? formatDecimal(row.avg_entry) : '0',
    exitPrice: row.exit_price !== null ? formatDecimal(row.exit_price) : null,
    realizedPnl: signedMoney(toNumber(row.realized_pnl)),
    isWin: row.is_win,
    closeReason: mapCloseReason(row.status, row.close_action),
    leverage: row.leverage !== null ? `${formatDecimal(row.leverage)}x` : null,
    openedAt: (row.opened_at ?? row.close_key).toISOString(),
    closedAt: row.close_key.toISOString(),
    durationMs: openedMs !== null ? Math.max(0, closedMs - openedMs) : 0,
    status: row.status,
  }
}

@Injectable()
export class PositionsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** GET /api/positions — зеркало Bybit /v5/position/list (design/project/Admin.dc.html:394-475),
   *  только реально открытые (size<>0). LEFT JOIN trades — margin_mode/tradeRef (trade_id может
   *  быть не заведён, если позиция создана вне пайплайна — в Ф1 такого не бывает, но FK nullable).
   *  Keyset-пагинация по СТАБИЛЬНОМУ (trades.opened_at, channel_id, symbol) — та же конвенция
   *  bare-array, что и actions.service.ts (Task 2). opened_at, а не volatile updated_at (F6). */
  async listPositions(filter: PositionsFilter): Promise<PositionDto[]> {
    let query = this.database.db
      .selectFrom('positions as p')
      .innerJoin('channels as c', 'c.id', 'p.channel_id')
      .leftJoin('trades as t', 't.id', 'p.trade_id')
      .select([
        'p.symbol as symbol',
        'p.side as side',
        'p.size as size',
        'p.avg_price as avg_price',
        'p.mark_price as mark_price',
        'p.liq_price as liq_price',
        'p.leverage as leverage',
        'p.unrealised_pnl as unrealised_pnl',
        'p.position_im as position_im',
        'p.take_profit as take_profit',
        'p.stop_loss as stop_loss',
        'p.channel_id as channel_id',
        'c.title as channel_title',
        'c.key as channel_key',
        't.human_ref as human_ref',
        't.margin_mode as margin_mode',
      ])
      .where(sql<boolean>`p.size <> 0`)

    if (filter.channel && filter.channel !== 'all') {
      const channelId = Number(filter.channel)
      if (Number.isFinite(channelId)) query = query.where('p.channel_id', '=', channelId)
    }
    if (filter.side && SIDES.has(filter.side)) {
      query = query.where('p.side', '=', filter.side as Side)
    }
    if (filter.margin && MARGIN_MODES.has(filter.margin)) {
      query = query.where(sql<boolean>`lower(coalesce(t.margin_mode, 'cross')) = ${filter.margin}`)
    }
    if (filter.q && filter.q.trim()) {
      // design/project/Admin.dc.html + docs/superpowers/research/frontend-inventory.md §2:
      // поиск на Positions матчит symbol+источник(канал)+tradeRef, не только symbol (в отличие
      // от Actions, где поиск только по pair/symbol). escapeLikePattern — иначе `%`/`_` в
      // пользовательском вводе работали бы как LIKE-wildcard (Minor #3 финального ревью Ф1).
      const like = `%${escapeLikePattern(filter.q.trim())}%`
      query = query.where(
        sql<boolean>`(p.symbol ILIKE ${like} OR coalesce(c.title, c.key) ILIKE ${like} OR t.human_ref ILIKE ${like})`,
      )
    }
    if (filter.before) {
      const cursor = parsePositionCursor(filter.before.trim())
      if (cursor) {
        // Keyset по СТАБИЛЬНОМУ ключу (trades.opened_at, channel_id, symbol) — строго "старше"
        // курсора в том же порядке, что и ORDER BY ниже. Адверсариал-ревью F6: раньше ключом был
        // p.updated_at, но apply-tick.ts бампает positions.updated_at на КАЖДЫЙ mark-тик (~2с) →
        // граница страницы уезжала под курсором между загрузкой и «Load more», давая дубли/пропуски.
        // opened_at (момент открытия сделки) неизменен → границы страниц стабильны. COALESCE(...,
        // 'epoch') — позиции без trade/opened_at (edge) сортируются последними, не роняя ключ.
        // Подзапрос резолвит ключ курсора по (channel_id, symbol) = PK: строка исчезла → NULL →
        // пустая страница, не крэш.
        query = query.where(
          sql<boolean>`(coalesce(t.opened_at, 'epoch'::timestamptz), p.channel_id, p.symbol) < (SELECT coalesce(t2.opened_at, 'epoch'::timestamptz), p2.channel_id, p2.symbol FROM positions p2 LEFT JOIN trades t2 ON t2.id = p2.trade_id WHERE p2.channel_id = ${cursor.channelId} AND p2.symbol = ${cursor.symbol})`,
        )
      }
    }

    const rows = await query
      .orderBy(sql`coalesce(t.opened_at, 'epoch'::timestamptz)`, 'desc')
      .orderBy('p.channel_id', 'desc')
      .orderBy('p.symbol', 'desc')
      .limit(clampLimit(filter.limit))
      .execute()
    return rows.map(toPositionDto)
  }

  /** GET /api/positions/history — ЗАКРЫТЫЕ/отменённые сделки (trades, НЕ positions). Keyset по
   *  (COALESCE(closed_at, updated_at), id) через idx_trade_history; фильтры channel/status.
   *  closeReason — последний закрывающий action.type по trade_id; exitPrice — взвешенная средняя
   *  reduceOnly-исполнений (executions⨝orders, у executions нет колонки reduce_only). */
  async listClosedTrades(filter: ClosedTradesFilter): Promise<ClosedTradeDto[]> {
    const statusRaw = (filter.status ?? 'closed').toLowerCase()
    const statuses: ('closed' | 'cancelled')[] =
      statusRaw === 'all' ? ['closed', 'cancelled'] : statusRaw === 'cancelled' ? ['cancelled'] : ['closed']

    let query = this.database.db
      .selectFrom('trades as t')
      .innerJoin('channels as c', 'c.id', 't.channel_id')
      .select([
        't.id as id',
        't.human_ref as human_ref',
        't.channel_id as channel_id',
        'c.title as channel_title',
        'c.key as channel_key',
        't.symbol as symbol',
        't.side as side',
        't.avg_entry as avg_entry',
        't.realized_pnl as realized_pnl',
        't.is_win as is_win',
        't.leverage as leverage',
        't.status as status',
        't.opened_at as opened_at',
        sql<Date>`coalesce(t.closed_at, t.updated_at)`.as('close_key'),
        // Взвешенная средняя цена ВЫХОДА: reduce-only исполнения по сделке. executions не хранит
        // reduce_only (это колонка orders) — джойним orders. dry_run без исполнений → NULL.
        sql<string | null>`(
          SELECT (SUM(e.exec_price * e.exec_qty) / NULLIF(SUM(e.exec_qty), 0))::text
          FROM executions e
          JOIN orders o ON o.id = e.order_id
          WHERE e.trade_id = t.id AND o.reduce_only = true
        )`.as('exit_price'),
        // Последний закрывающий action по сделке (ORDER BY created_at DESC) — источник причины
        // закрытия (sl_hit/tp_hit/close/...). ::text — enum action_type в строку для маппинга.
        sql<string | null>`(
          SELECT a.type::text
          FROM actions a
          WHERE a.trade_id = t.id
            AND a.type IN ('close', 'partial_close', 'tp_hit', 'sl_hit', 'close_all')
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        )`.as('close_action'),
      ])
      .where('t.status', 'in', statuses)

    if (filter.channel && filter.channel !== 'all') {
      const channelId = Number(filter.channel)
      if (Number.isFinite(channelId)) query = query.where('t.channel_id', '=', channelId)
    }
    if (filter.before && filter.before.trim().length > 0) {
      const beforeRef = filter.before.trim()
      // Keyset по (close_key, human_ref) — тот же приём, что и actions, но тай-брейкер human_ref
      // (клиент видит только его). COALESCE(closed_at, updated_at) в обеих частях сравнения:
      // cancelled-сделки без closed_at пагинируются стабильно. Несуществующий before → подзапрос
      // пуст → NULL → пустая страница, не крэш (защитно, как протухший курсор у actions).
      query = query.where(
        sql<boolean>`(coalesce(t.closed_at, t.updated_at), t.human_ref) < (SELECT coalesce(closed_at, updated_at), human_ref FROM trades WHERE human_ref = ${beforeRef})`,
      )
    }

    const rows = await query
      .orderBy(sql`coalesce(t.closed_at, t.updated_at)`, 'desc')
      .orderBy('t.human_ref', 'desc')
      .limit(clampLimit(filter.limit))
      .execute()
    return rows.map((row) => toClosedTradeDto(row as ClosedTradeQueryRow))
  }

  /** GET /api/positions/stats — агрегаты по ВСЕМ открытым позициям, вне активных фильтров
   *  (design/frontend-inventory.md gap #8: "totals over full set" — сознательно не режется q/side).
   *  Task 2: realizedPnl = SUM(trades.realized_pnl) закрытых; totalPnl = unrealised(open) + realized. */
  async getStats(): Promise<PositionStatsDto> {
    const rows = await this.database.db
      .selectFrom('positions')
      .select(['size', 'avg_price', 'mark_price', 'leverage', 'unrealised_pnl', 'position_im'])
      .where(sql<boolean>`size <> 0`)
      .execute()

    let pnlSum = 0
    let notionalSum = 0
    let marginSum = 0
    for (const row of rows) {
      pnlSum += pnlOf(row.unrealised_pnl)
      notionalSum += notionalOf(row.size, row.mark_price, row.avg_price)
      marginSum += marginOf(row.size, row.mark_price, row.avg_price, row.position_im, row.leverage)
    }

    // realized — агрегируем в SQL (numeric→::text), Number() только для форматирования витрины
    // (тот же приём, что и toNumber выше — не денежная математика во float, а сумма из БД).
    const realizedRow = await sql<{ realized: string }>`
      SELECT COALESCE(SUM(realized_pnl), 0)::text AS realized
      FROM trades
      WHERE status = 'closed'
    `.execute(this.database.db)
    const realizedSum = toNumber(realizedRow.rows[0]?.realized ?? '0')

    return {
      openPositions: rows.length,
      unrealisedPnl: signedMoney(pnlSum),
      positionValue: money(notionalSum),
      marginUsed: money(marginSum),
      realizedPnl: signedMoney(realizedSum),
      totalPnl: signedMoney(pnlSum + realizedSum),
    }
  }

  /** GET /api/positions/stats/by-channel — PnL, сгруппированный по каналам. Открытые позиции
   *  (unrealised) и закрытые сделки (realized + winRate) живут в РАЗНЫХ таблицах — агрегируем
   *  каждую отдельным GROUP BY и мержим по channel_id (канал попадает в выдачу, если у него есть
   *  открытая позиция ИЛИ закрытая/отменённая сделка). */
  async getStatsByChannel(): Promise<ChannelPnlDto[]> {
    const openAgg = await sql<{ channel_id: number; open_positions: string; unrealised: string }>`
      SELECT channel_id,
             count(*)::text AS open_positions,
             COALESCE(SUM(unrealised_pnl), 0)::text AS unrealised
      FROM positions
      WHERE size <> 0
      GROUP BY channel_id
    `.execute(this.database.db)

    const tradeAgg = await sql<{ channel_id: number; realized: string; decided: string; wins: string }>`
      SELECT channel_id,
             COALESCE(SUM(realized_pnl) FILTER (WHERE status = 'closed'), 0)::text AS realized,
             count(*) FILTER (WHERE status = 'closed' AND is_win IS NOT NULL)::text AS decided,
             count(*) FILTER (WHERE status = 'closed' AND is_win)::text AS wins
      FROM trades
      WHERE status IN ('closed', 'cancelled')
      GROUP BY channel_id
    `.execute(this.database.db)

    const openMap = new Map(openAgg.rows.map((r) => [Number(r.channel_id), r]))
    const tradeMap = new Map(tradeAgg.rows.map((r) => [Number(r.channel_id), r]))
    const channelIds = [...new Set([...openMap.keys(), ...tradeMap.keys()])].sort((a, b) => a - b)

    if (channelIds.length === 0) return []

    const channels = await this.database.db
      .selectFrom('channels')
      .select(['id', 'title', 'key'])
      .where('id', 'in', channelIds)
      .execute()
    const titleMap = new Map(channels.map((c) => [c.id, c.title ?? c.key]))

    return channelIds.map((id): ChannelPnlDto => {
      const open = openMap.get(id)
      const trade = tradeMap.get(id)
      const unrealisedNum = open ? toNumber(open.unrealised) : 0
      const realizedNum = trade ? toNumber(trade.realized) : 0
      const decided = trade ? Number(trade.decided) : 0
      const wins = trade ? Number(trade.wins) : 0
      return {
        channelId: id,
        channelTitle: titleMap.get(id) ?? String(id),
        openPositions: open ? Number(open.open_positions) : 0,
        unrealisedPnl: signedMoney(unrealisedNum),
        realizedPnl: signedMoney(realizedNum),
        totalPnl: signedMoney(unrealisedNum + realizedNum),
        winRate: formatWinRate(decided, wins),
      }
    })
  }
}
