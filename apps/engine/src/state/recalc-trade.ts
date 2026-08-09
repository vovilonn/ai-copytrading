// Пересчёт денежных агрегатов сделки из её исполнений. Единственный писатель trades.realized_pnl /
// fees_paid / is_win в live-режиме — и WS-путь (applyExecutionPush), и REST-догон истории
// (sync/backfill-*) зовут ИМЕННО эту функцию. Два независимых писателя денег = гарантированное
// расхождение формул, поэтому её нельзя дублировать.
//
// ПРИНЦИП: агрегаты ПЕРЕСЧИТЫВАЮТСЯ (SUM по executions), а не инкрементируются (`+=`). Поэтому
// повторный/параллельный прогон реконсиляции структурно не может задвоить деньги: пересчёт
// идемпотентен, а вставка исполнений защищена UNIQUE(bybit_exec_id).

import { Decimal } from 'decimal.js'
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
 * - `realized_pnl` = SUM(exec_pnl) − SUM(exec_fee) — НЕТТО, ровно то, на что изменился баланс.
 *
 *   Раньше здесь лежало БРУТТО (до комиссий), потому что таковы данные источников: WS-пуш
 *   execution отдаёт брутто пофилльно, а REST-догон восстанавливает брутто из closed-pnl обратной
 *   формулой (sync/backfill-closed-pnl.ts). Пофилльные строки `executions` так и остаются брутто —
 *   это честная запись сырых данных биржи. Но АГРЕГАТ СДЕЛКИ читают как «сколько заработали», и
 *   комиссию из него не вычитал НИКТО: ни карточки PnL, ни таблица закрытых сделок, ни winRate.
 *
 *   Живой счёт 10.08.2026: журнал показывал +17.05 при том, что биржа по тем же сделкам отдавала
 *   closedPnl +8.63, а депозит вырос на ~6 — вся разница ровно в комиссиях (8.38). Одно место с
 *   вычитанием надёжнее, чем требование «не забудь вычесть» в каждом потребителе: брутто при
 *   необходимости восстанавливается как realized_pnl + fees_paid.
 *
 *   Инвариант проверяется на живых числах: closedPnl биржи = брутто − openFee − closeFee, то есть
 *   ровно эта же формула (см. арифметику в шапке backfill-closed-pnl.ts).
 * - `fees_paid` = SUM(exec_fee) — детализация к нетто-PnL (и то, чем брутто отличается от нетто).
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

  // Вычитание — в SQL (NUMERIC), а не в JS: деньги нельзя гонять через float (CLAUDE.md).
  const { rows } = await sql<{ pnl: string; fees: string }>`
    SELECT COALESCE(SUM(exec_pnl), 0)::text AS pnl,
           COALESCE(SUM(exec_fee), 0)::text AS fees
    FROM executions
    WHERE trade_id = ${tradeId}::uuid
  `.execute(trx)

  const feesPaid = rows[0]?.fees ?? '0'
  const realizedPnl = new Decimal(rows[0]?.pnl ?? '0').minus(feesPaid).toString()
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
