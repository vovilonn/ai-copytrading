import { Decimal } from 'decimal.js'
import { floorTo, type Numeric } from './leverage.js'

export interface ComputeSizeParams {
  /** Риск в процентах от equity (0..100). Если задан — notional считается через stopDistance. */
  riskPct?: Numeric
  equity: Numeric
  /**
   * МАРЖА канала на сделку ($) — реальные деньги с баланса, а не размер позиции. Используется,
   * когда в сигнале нет риска в процентах. Размер позиции получается умножением на плечо:
   * trade_size=20 при плече 10 → позиция на $200, из баланса заблокировано $20.
   */
  tradeSize: Numeric
  entry: Numeric
  sl: Numeric
  lev: Numeric
  minNotional: Numeric
  /** Потолок совокупной экспозиции на символ (R10), опционален. */
  maxSymbolNotional?: Numeric
  /**
   * СВОБОДНАЯ маржа счёта. Не путать с `equity`: депозит включает деньги, уже занятые под
   * открытые позиции, а новый ордер биржа проверяет именно по свободному остатку.
   * Не задан — потолок по свободной марже не применяется (бэктест/dry-run).
   */
  availableBalance?: Numeric
  qtyStep: Numeric
}

export type ComputeSizeOk = { notional: Decimal; qty: Decimal }
export type ComputeSizeSkip = { skip: 'below_min_notional' | 'zero_qty' | 'insufficient_margin' }
export type ComputeSizeResult = ComputeSizeOk | ComputeSizeSkip

/**
 * Сайзинг позиции (design spec §сайзинг / research bybit-execution.md):
 *   d = |entry - sl| / entry
 *   есть riskPct и sl  →  notional = (riskPct/100 * equity) / d
 *   нет riskPct        →  notional = tradeSize * lev                        (фолбэк)
 *   notional = min(notional, equity * lev, available * lev?, maxSymbolNotional?)  (жёсткий потолок)
 *   qty = floor_to(qtyStep, notional / entry)
 *   если notional < minNotional → skip('below_min_notional')
 *   если qty === 0              → skip('zero_qty')
 *
 * ⚠️ `tradeSize` — это МАРЖА, а не размер позиции (решение заказчика 27.07.2026: «когда я ставлю
 * 20$, я хочу, чтобы это были реальные 20$ моего баланса»). Раньше эта же цифра означала нотионал,
 * и при плече 10 из депозита списывалось в 10 раз меньше заявленного — ровно наоборот тому, что
 * ожидает оператор, глядя на поле «Trade size».
 *
 * Потолок `equity * lev` заодно гарантирует, что маржа не превысит депозит: notional/lev ≤ equity.
 * `riskPct`-ветка не меняется — там размер задан риском на стоп, а не маржой.
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
    // Маржа × плечо = размер позиции. Именно столько денег оператор осознанно кладёт в сделку.
    notional = new Decimal(params.tradeSize).mul(lev)
  }

  // Жёсткий потолок: equity*lev всегда участвует, maxSymbolNotional — если задан.
  const caps = [equity.mul(lev)]
  if (params.maxSymbolNotional !== undefined) {
    caps.push(new Decimal(params.maxSymbolNotional))
  }

  // ⚠️ ПОТОЛОК ПО СВОБОДНОЙ МАРЖЕ. Депозит — это НЕ то, чем можно открыть новую позицию: почти
  // весь он может быть уже занят под текущие. Живой случай прода 01.08.2026: депозит $251, пять
  // открытых позиций держат $190, свободно $9 — а сайзинг считал потолок от $251 и отправил ордер
  // на $500. Биржа отвергла его кодом 110007, сообщение ушло в needs_review, сделки не случилось.
  // Лучше войти меньшим объёмом, чем не войти вовсе.
  if (params.availableBalance !== undefined) {
    caps.push(new Decimal(params.availableBalance).mul(lev))
  }
  notional = Decimal.min(notional, ...caps)

  if (notional.lt(minNotional)) {
    // Разделяем причины: «свободной маржи не хватает даже на минимальный ордер» — это состояние
    // счёта, а не свойство сигнала, и оператору важно видеть разницу.
    const marginCap = params.availableBalance !== undefined ? new Decimal(params.availableBalance).mul(lev) : null
    if (marginCap !== null && marginCap.lt(minNotional)) return { skip: 'insufficient_margin' }
    return { skip: 'below_min_notional' }
  }

  const qty = floorTo(qtyStep, notional.div(entry))
  if (qty.isZero()) {
    return { skip: 'zero_qty' }
  }

  return { notional, qty }
}
