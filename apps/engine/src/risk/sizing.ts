import { Decimal } from 'decimal.js'
import { floorTo, type Numeric } from './leverage.js'

export interface ComputeSizeParams {
  /** Риск в процентах от equity (0..100). Если задан — notional считается через stopDistance. */
  riskPct?: Numeric
  equity: Numeric
  /** Фолбэк-notional канала ($), используется когда riskPct не задан. */
  tradeSize: Numeric
  entry: Numeric
  sl: Numeric
  lev: Numeric
  minNotional: Numeric
  /** Потолок совокупной экспозиции на символ (R10), опционален. */
  maxSymbolNotional?: Numeric
  qtyStep: Numeric
}

export type ComputeSizeOk = { notional: Decimal; qty: Decimal }
export type ComputeSizeSkip = { skip: 'below_min_notional' | 'zero_qty' }
export type ComputeSizeResult = ComputeSizeOk | ComputeSizeSkip

/**
 * Сайзинг позиции (design spec §сайзинг / research bybit-execution.md, дословно):
 *   d = |entry - sl| / entry
 *   есть riskPct и sl  →  notional = (riskPct/100 * equity) / d
 *   нет riskPct        →  notional = tradeSize                              (фолбэк)
 *   notional = min(notional, equity * lev, maxSymbolNotional?)              (жёсткий потолок)
 *   qty = floor_to(qtyStep, notional / entry)
 *   если notional < minNotional → skip('below_min_notional')
 *   если qty === 0              → skip('zero_qty')
 *
 * `entry` здесь — уже одно число (для диапазона ядро само резолвит цену лимитки/среднюю
 * ДО вызова computeSize — не забота этой функции).
 */
export function computeSize(params: ComputeSizeParams): ComputeSizeResult {
  const equity = new Decimal(params.equity)
  const entry = new Decimal(params.entry)
  const sl = new Decimal(params.sl)
  const lev = new Decimal(params.lev)
  const minNotional = new Decimal(params.minNotional)
  const qtyStep = new Decimal(params.qtyStep)

  let notional: Decimal
  if (params.riskPct !== undefined) {
    const riskPct = new Decimal(params.riskPct)
    const d = sl.minus(entry).abs().div(entry)
    notional = riskPct.div(100).mul(equity).div(d)
  } else {
    notional = new Decimal(params.tradeSize)
  }

  // Жёсткий потолок: equity*lev всегда участвует, maxSymbolNotional — если задан.
  const caps = [equity.mul(lev)]
  if (params.maxSymbolNotional !== undefined) {
    caps.push(new Decimal(params.maxSymbolNotional))
  }
  notional = Decimal.min(notional, ...caps)

  if (notional.lt(minNotional)) {
    return { skip: 'below_min_notional' }
  }

  const qty = floorTo(qtyStep, notional.div(entry))
  if (qty.isZero()) {
    return { skip: 'zero_qty' }
  }

  return { notional, qty }
}
