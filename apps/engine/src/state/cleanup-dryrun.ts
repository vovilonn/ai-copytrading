// Разовая чистка фантомных dry_run позиций (Ф.., задача 3, план
// docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md, Task 3 / Task 5: "перед первым
// live-стартом — разовая чистка 76 фантомных dry_run позиций"). Всё, что накопилось в dry_run
// (сделки, "позиции", захваченные символы, открытые ордера) не имеет реального биржевого
// подтверждения — при переключении EXECUTION_MODE=live движок должен стартовать с чистого листа,
// иначе reconcileOnStart (bybit/reconcile.ts) увидит расхождение "в БД открыто — на бирже нет" и
// либо ошибочно закроет их с левым realized_pnl, либо просто будет путать статистику/UI.
//
// Реализация переиспользует `closeTrade` (state/trades.ts) для самого перехода trades.status,
// а не пишет отдельный UPDATE trades — так гарантированно не расходится логика "что значит закрыть
// сделку" (closed_at, is_win, публикация 'channel.stats') между обычным путём исполнения и этим
// разовым скриптом (DRY, тот же принцип, что и во всех вызывающих closeTrade местах пайплайна).
// `isWin: null` передаётся ЯВНО (не выводится из realized_pnl) — задача явно требует "is_win
// остаётся NULL — исход неизвестен": это принудительное закрытие фантома, а не настоящий результат
// сделки, даже если realized_pnl в БД случайно оказался ненулевым.
//
// Symbol_ownership/positions/orders обновляются точечно ПО КАЖДОЙ такой сделке (channel_id+symbol
// из строки trades, trade_id для orders — колонка orders.trade_id всегда проставлена для
// entry/add/tp/sl/close-ордеров, см. execution/bybit.adapter.ts и dry-run.adapter.ts), а НЕ одним
// глобальным UPDATE без фильтра — так скрипт не трогает несвязанные закрытые/отменённые записи
// (идемпотентность: повторный запуск, когда открытых сделок больше нет, находит 0 строк везде).
//
// Вся операция — одна транзакция (всё или ничего): крэш посреди чистки не должен оставить часть
// сделок закрытыми, а часть — нет (полу-состояние опаснее, чем откат целиком и повторный запуск).

import type { Kysely, Transaction } from 'kysely'
import type { DB } from 'api/db/database.js'
import { closeTrade } from './trades.js'

// ГРАБЛЯ бэкенда (см. отчёт задачи): бриф изначально упоминал 'partially_filled' для trades, но
// реальный enum TradeStatus (packages/shared/src/domain.ts) — 'pending'|'open'|'partially_closed'|
// 'closed'|'cancelled'|'skipped'. Открытые/частично-открытые сделки — 'open' и 'partially_closed'.
const OPEN_TRADE_STATUSES = ['open', 'partially_closed'] as const

// OrderStatus (shared/domain.ts) — открытые/незавершённые ордера, которые ещё МОГЛИ БЫ исполниться
// на бирже (которой в dry_run никогда не было) — 'expired'/'filled'/'rejected'/'cancelled' уже
// финальны и не трогаются.
const OPEN_ORDER_STATUSES = ['created', 'pending_submit', 'submitted', 'partially_filled'] as const

export interface CleanupReport {
  /** Сколько сделок переведено 'open'/'partially_closed' -> 'closed'. */
  tradesClosed: number
  /** Сколько строк positions обнулено (size=0) по (channel_id,symbol) закрытых сделок. */
  positionsZeroed: number
  /** Сколько строк symbol_ownership освобождено (released_at=now(), было NULL) по trade_id. */
  ownershipReleased: number
  /** Сколько строк orders переведено в 'cancelled' (были submitted/created/pending_submit/partially_filled). */
  ordersCancelled: number
}

const EMPTY_REPORT: CleanupReport = { tradesClosed: 0, positionsZeroed: 0, ownershipReleased: 0, ordersCancelled: 0 }

/**
 * Чистая (тестируемая без CLI) логика разовой чистки — вызывающий CLI-скрипт
 * (`scripts/cleanup-dryrun-positions.mjs` -> `src/cleanup-dryrun-cli.ts`) только печатает отчёт.
 *
 * Идемпотентна: второй прогон подряд (когда открытых 'open'/'partially_closed' сделок уже нет)
 * находит 0 строк на каждом из четырёх шагов и возвращает нулевой отчёт — не бросает и не
 * пересчитывает уже закрытое/отменённое.
 */
export async function cleanupDryRunPositions(db: Kysely<DB>): Promise<CleanupReport> {
  return db.transaction().execute(async (trx) => cleanupInTransaction(trx))
}

async function cleanupInTransaction(trx: Transaction<DB>): Promise<CleanupReport> {
  const now = new Date()

  const openTrades = await trx
    .selectFrom('trades')
    .select(['id', 'channel_id', 'symbol'])
    .where('status', 'in', OPEN_TRADE_STATUSES)
    .execute()

  if (openTrades.length === 0) return EMPTY_REPORT

  const report: CleanupReport = { ...EMPTY_REPORT }

  for (const trade of openTrades) {
    // symbol_ownership — считаем affected-строки САМИ (RETURNING), а не полагаемся на побочный
    // эффект closeTrade ниже (тот делает то же самое обновление, но не возвращает счётчик) —
    // порядок (до closeTrade) неважен: WHERE released_at IS NULL делает второй UPDATE (внутри
    // closeTrade) идемпотентным no-op после этого.
    const released = await trx
      .updateTable('symbol_ownership')
      .set({ released_at: now })
      .where('trade_id', '=', trade.id)
      .where('released_at', 'is', null)
      .returning('id')
      .execute()
    report.ownershipReleased += released.length

    const zeroed = await trx
      .updateTable('positions')
      .set({ size: '0', updated_at: now })
      .where('channel_id', '=', trade.channel_id)
      .where('symbol', '=', trade.symbol)
      .where('size', '!=', '0')
      .returning(['channel_id', 'symbol'])
      .execute()
    report.positionsZeroed += zeroed.length

    const cancelledOrders = await trx
      .updateTable('orders')
      .set({ status: 'cancelled', cancelled_at: now, updated_at: now })
      .where('trade_id', '=', trade.id)
      .where('status', 'in', OPEN_ORDER_STATUSES)
      .returning('id')
      .execute()
    report.ordersCancelled += cancelledOrders.length

    // closeTrade переиспользуется ради консистентности перехода trades.status/closed_at/
    // 'channel.stats' с обычным путём исполнения (см. топ-комментарий модуля). isWin:null —
    // явный неизвестный исход, не вывод из (возможно нулевого dry_run) realized_pnl.
    await closeTrade(trx, { tradeId: trade.id, status: 'closed', closedAt: now, isWin: null })
    report.tradesClosed += 1
  }

  return report
}
