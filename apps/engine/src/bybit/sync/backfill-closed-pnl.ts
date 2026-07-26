// Догон реализованного PnL — единственный источник правды по деньгам закрытий, включая РУЧНЫЕ.
//
// ПОЧЕМУ ОТДЕЛЬНЫМ ШАГОМ. `/v5/execution/list` не отдаёт PnL вообще (только комиссию), поэтому
// строки, дочитанные backfill-executions, лежат с exec_pnl = 0. Пересчитать сделку по ним, не
// заполнив PnL, значит ОБНУЛИТЬ уже правильно посчитанный realized_pnl. Настоящий PnL живёт в
// `/v5/position/closed-pnl`.
//
// СЕМАНТИКА (проверена арифметически на живых числах demo, а не по докам):
//   closedPnl = -0.03360805   ← НЕТТО, уже за вычетом обеих комиссий
//   openFee   =  0.0043109
//   closeFee  =  0.00429715
//   gross     = -0.025        = closedPnl + openFee + closeFee     ✔
// В БД `executions.exec_pnl` хранится БРУТТО (так его отдаёт WS-пуш execution), а комиссии живут
// отдельной колонкой exec_fee. Поэтому из closedPnl восстанавливаем БРУТТО обратной формулой —
// иначе комиссии вычлись бы дважды.
//
// ИДЕМПОТЕНТНОСТЬ: это UPDATE ... SET (присваивание), а не инкремент. Повторный прогон даёт тот же
// результат. Патч сужен до source='rest': строки, пришедшие по WS, уже несут ТОЧНЫЙ exec_pnl на
// каждый филл, а closed-pnl агрегирован по ордеру — трогать их нельзя.

import { Decimal } from 'decimal.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { ClosedPnl } from '../rest-client.js'
import { chunkWindows, cursorKey, resolveSyncFrom, writeCursor } from './cursor.js'

export interface ClosedPnlBackfillRest {
  getClosedPnl(params: { startTime?: number; endTime?: number }): Promise<ClosedPnl[]>
}

export interface BackfillClosedPnlResult {
  fetched: number
  /** Сколько строк executions получили реальный PnL. */
  patched: number
  affectedTradeIds: string[]
  truncated: boolean
}

export async function backfillClosedPnl(
  db: Kysely<DB>,
  rest: ClosedPnlBackfillRest,
  nowMs: number,
  oldestLiveTradeMs?: number | null,
  /** Аккаунт, чью историю догоняем: курсор у каждого свой (см. cursor.ts::cursorKey). */
  accountFingerprint?: string,
): Promise<BackfillClosedPnlResult> {
  const { from, truncated } = await resolveSyncFrom(db, cursorKey('sync:closed_pnl', accountFingerprint), nowMs, oldestLiveTradeMs)
  const windows = chunkWindows(from, nowMs)

  const result: BackfillClosedPnlResult = { fetched: 0, patched: 0, affectedTradeIds: [], truncated }
  const affected = new Set<string>()

  for (const window of windows) {
    const rows = await rest.getClosedPnl({ startTime: window.start, endTime: window.end })
    result.fetched += rows.length

    for (const row of rows) {
      const patched = await patchExecutionsPnl(db, row)
      result.patched += patched.patched
      for (const id of patched.tradeIds) affected.add(id)
    }

    await writeCursor(db, cursorKey('sync:closed_pnl', accountFingerprint), window.end)
  }

  result.affectedTradeIds = [...affected]
  return result
}

interface PatchResult {
  patched: number
  tradeIds: string[]
}

/**
 * Разносит брутто-PnL закрывающего ордера по его REST-исполнениям пропорционально объёму филла.
 *
 * Bybit агрегирует closed-pnl ПО ОРДЕРУ (`fillCount` может быть > 1), а мы храним PnL пофилльно —
 * поэтому при нескольких филлах одного ордера делим брутто пропорционально exec_qty. Остаток от
 * округления отдаём последнему филлу, чтобы сумма частей ТОЧНО совпала с брутто (иначе realized_pnl
 * сделки поехал бы на копейки, а деньги должны сходиться до последнего знака).
 */
async function patchExecutionsPnl(db: Kysely<DB>, row: ClosedPnl): Promise<PatchResult> {
  const gross = new Decimal(row.closedPnl).plus(row.openFee || '0').plus(row.closeFee || '0')

  return db.transaction().execute(async (trx) => {
    // Только REST-строки: у WS-строк PnL уже точный, пофилльный.
    const fills = await trx
      .selectFrom('executions')
      .select(['id', 'trade_id', 'exec_qty'])
      .where('bybit_order_id', '=', row.orderId)
      .where('source', '=', 'rest')
      .where(sql<boolean>`closed_size <> 0`)
      .orderBy('exec_ts', 'asc')
      .orderBy('id', 'asc')
      .execute()

    if (fills.length === 0) return { patched: 0, tradeIds: [] }

    const totalQty = fills.reduce((sum, f) => sum.plus(f.exec_qty), new Decimal(0))
    if (totalQty.isZero()) return { patched: 0, tradeIds: [] }

    let distributed = new Decimal(0)
    let patched = 0
    const tradeIds: string[] = []

    for (const [index, fill] of fills.entries()) {
      const isLast = index === fills.length - 1
      const share = isLast
        ? gross.minus(distributed) // последний забирает остаток — сумма частей == gross ровно
        : gross.mul(new Decimal(fill.exec_qty)).div(totalQty)
      distributed = distributed.plus(share)

      await trx
        .updateTable('executions')
        .set({ exec_pnl: share.toString() })
        .where('id', '=', fill.id)
        .execute()

      patched++
      if (fill.trade_id) tradeIds.push(fill.trade_id)
    }

    return { patched, tradeIds }
  })
}
