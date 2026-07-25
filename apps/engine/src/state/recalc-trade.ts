// Пересчёт денежных агрегатов сделки из её исполнений. Единственный писатель trades.realized_pnl /
// fees_paid / is_win в live-режиме — и WS-путь (applyExecutionPush), и REST-догон истории
// (sync/backfill-*) зовут ИМЕННО эту функцию. Два независимых писателя денег = гарантированное
// расхождение формул, поэтому её нельзя дублировать.
//
// ПРИНЦИП: агрегаты ПЕРЕСЧИТЫВАЮТСЯ (SUM по executions), а не инкрементируются (`+=`). Поэтому
// повторный/параллельный прогон реконсиляции структурно не может задвоить деньги: пересчёт
// идемпотентен, а вставка исполнений защищена UNIQUE(bybit_exec_id).

import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { TradeStatus } from 'shared/domain.js'
import { computeIsWin, emitChannelStats } from './trades.js'

/**
 * Статус сделки по её фактическому состоянию.
 *
 * `partially_closed` до сих пор не писал НИКТО (колонка была мертва): при частичной фиксации —
 * хоть по сигналу канала, хоть руками оператора на бирже — сделка оставалась 'open'. Теперь статус
 * выводится из двух фактов: остался ли объём и были ли ЗАКРЫВАЮЩИЕ исполнения (closed_size > 0).
 */
export function resolveTradeStatus(size: string, hasClosingFills: boolean): TradeStatus {
  if (Number(size) === 0) return 'closed'
  return hasClosingFills ? 'partially_closed' : 'open'
}

export interface RecalcResult {
  realizedPnl: string
  feesPaid: string
  isWin: boolean | null
}

/**
 * Пересчитывает деньги сделки из `executions` и публикует обновлённый Win Rate канала.
 *
 * - `realized_pnl` = SUM(exec_pnl) — БРУТТО (до комиссий). Это семантика, заложенная в БД: WS-пуш
 *   execution отдаёт именно брутто (проверено: exec_pnl=-0.025 при (78.13-78.38)*0.1). REST-догон
 *   выводит брутто из closed-pnl обратной формулой (см. sync/backfill-closed-pnl.ts), чтобы не
 *   смешивать в одной колонке две разные величины.
 * - `fees_paid` = SUM(exec_fee) — у этого поля РАНЬШЕ НЕ БЫЛО НИ ОДНОГО ПИСАТЕЛЯ: комиссии копились
 *   в executions и никуда не агрегировались, в журнале всегда стоял 0.
 * - `is_win` ПЕРЕСЧИТЫВАЕТСЯ, а не ставится однократно в closeTrade. Иначе любой догон истории
 *   (который меняет realized_pnl уже закрытой сделки) оставлял бы Win Rate канала ложным навсегда.
 *   Для незакрытых сделок is_win не трогаем — исход ещё не определён.
 */
export async function recalcTradeMoney(trx: Kysely<DB>, tradeId: string): Promise<RecalcResult | null> {
  const trade = await trx
    .selectFrom('trades')
    .select(['id', 'channel_id', 'status'])
    .where('id', '=', tradeId)
    .executeTakeFirst()
  if (!trade) return null

  const { rows } = await sql<{ pnl: string; fees: string }>`
    SELECT COALESCE(SUM(exec_pnl), 0)::text AS pnl,
           COALESCE(SUM(exec_fee), 0)::text AS fees
    FROM executions
    WHERE trade_id = ${tradeId}::uuid
  `.execute(trx)

  const realizedPnl = rows[0]?.pnl ?? '0'
  const feesPaid = rows[0]?.fees ?? '0'
  // Исход известен только у закрытой сделки: у открытой PnL ещё «плавает» частичными фиксациями.
  const isWin = trade.status === 'closed' ? computeIsWin(realizedPnl) : null

  await trx
    .updateTable('trades')
    .set({
      realized_pnl: realizedPnl,
      fees_paid: feesPaid,
      updated_at: new Date(),
      ...(trade.status === 'closed' ? { is_win: isWin } : {}),
    })
    .where('id', '=', tradeId)
    .execute()

  // Win Rate канала считается по is_win закрытых сделок — после пересчёта он мог измениться.
  if (trade.status === 'closed') {
    await emitChannelStats(trx, trade.channel_id)
  }

  return { realizedPnl, feesPaid, isWin }
}

/** Пересчёт для набора сделок (догон истории затрагивает сразу несколько). */
export async function recalcTradesMoney(trx: Kysely<DB>, tradeIds: readonly string[]): Promise<number> {
  const unique = [...new Set(tradeIds)]
  let recalculated = 0
  for (const id of unique) {
    const result = await recalcTradeMoney(trx, id)
    if (result) recalculated++
  }
  return recalculated
}
