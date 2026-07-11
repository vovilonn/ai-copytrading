import { Decimal } from 'decimal.js'
import type { Side } from 'shared/domain.js'

/** Денежная математика — строго Decimal/строки (CLAUDE.md), никогда JS number (см. risk/leverage.ts). */
export type Numeric = string | Decimal

/**
 * Нереализованный PnL по живому mark price (task-10-brief.md, research bybit-execution.md §12):
 *   long:  (mark − avg) · size
 *   short: (avg − mark) · size
 * `size` здесь ВСЕГДА положительная величина — направление несёт отдельно `side`, а не знак size
 * (state/trades.ts: closeQty клампится Decimal.min(qty, position.size), newSize = Decimal.max(0, ...) —
 * size в БД никогда не бывает отрицательным).
 */
export function computeUnrealisedPnl(side: Side, size: Numeric, avgPrice: Numeric, markPrice: Numeric): Decimal {
  const diff = side === 'long' ? new Decimal(markPrice).minus(avgPrice) : new Decimal(avgPrice).minus(markPrice)
  return diff.mul(size)
}
