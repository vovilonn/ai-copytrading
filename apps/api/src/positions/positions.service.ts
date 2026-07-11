import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import type { Side } from 'shared/domain.js'
import type { PositionDto, PositionStatsDto } from 'shared/dto.js'
import { formatDecimal } from 'shared/numbers.js'
import { DatabaseService } from '../db/database.service.js'
import { escapeLikePattern } from '../db/like-escape.js'

/** Query-параметры GET /api/positions (task-8-brief.md) — все опциональны, отсутствие/'all' = без фильтра. */
export interface PositionsFilter {
  channel?: string
  side?: string
  margin?: string
  q?: string
}

const SIDES: ReadonlySet<string> = new Set<Side>(['long', 'short'])
const MARGIN_MODES: ReadonlySet<string> = new Set(['cross', 'isolated'])

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

@Injectable()
export class PositionsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** GET /api/positions — зеркало Bybit /v5/position/list (design/project/Admin.dc.html:394-475),
   *  только реально открытые (size<>0). LEFT JOIN trades — margin_mode/tradeRef (trade_id может
   *  быть не заведён, если позиция создана вне пайплайна — в Ф1 такого не бывает, но FK nullable). */
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

    const rows = await query.orderBy('p.updated_at', 'desc').orderBy('p.symbol', 'asc').execute()
    return rows.map(toPositionDto)
  }

  /** GET /api/positions/stats — агрегаты по ВСЕМ открытым позициям, вне активных фильтров
   *  (design/frontend-inventory.md gap #8: "totals over full set" — сознательно не режется q/side). */
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

    return {
      openPositions: rows.length,
      unrealisedPnl: signedMoney(pnlSum),
      positionValue: money(notionalSum),
      marginUsed: money(marginSum),
      // Task 1 (мониторинг PnL/баланса): временные дефолты ради компиляции DTO — реальный
      // расчёт (SUM(trades.realized_pnl) closed + unrealisedPnl) добавляет Task 2.
      realizedPnl: '0',
      totalPnl: '0',
    }
  }
}
