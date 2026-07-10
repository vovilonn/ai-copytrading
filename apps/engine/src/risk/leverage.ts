import { Decimal } from 'decimal.js'
import type { Side } from 'shared/domain.js'

/**
 * Денежная математика (research bybit-execution.md §6). Все входы — `string|Decimal`,
 * НИКОГДА JS `number`: 0.1+0.2 !== 0.3 во float, а здесь считается цена ликвидации
 * и плечо для реального ордера — ошибка округления стоит денег.
 */
export type Numeric = string | Decimal

/**
 * floor_to(step, x) = floor(x/step)*step — округление ВНИЗ к шагу (research §6/§7:
 * плечо кратно leverageStep, qty кратно qtyStep). floor, а не round/ceil — округление
 * вверх дало бы плечо/qty БОЛЬШЕ безопасного/доступного значения.
 */
export function floorTo(step: Numeric, x: Numeric): Decimal {
  return new Decimal(x).div(step).floor().mul(step)
}

export interface LiqPriceParams {
  entry: Numeric
  side: Side
  lev: Numeric
  mmr: Numeric
}

/**
 * Цена ликвидации, isolated-формула (research §6, сверено с примером Bybit HC:
 * entry=70000, lev=10, mmr=0.005 → short=76650, long=63350):
 *   long:  LiqPrice = entry * (1 - 1/lev + mmr)
 *   short: LiqPrice = entry * (1 + 1/lev - mmr)
 * Для cross эта формула — консервативная нижняя граница (реальный cross-liq дальше
 * от entry), поэтому безопасна и как оценка для cross (см. §6, конец).
 */
export function liqPrice({ entry, side, lev, mmr }: LiqPriceParams): Decimal {
  const e = new Decimal(entry)
  const invLev = new Decimal(1).div(lev)
  const m = new Decimal(mmr)
  return side === 'long'
    ? e.mul(new Decimal(1).minus(invLev).plus(m))
    : e.mul(new Decimal(1).plus(invLev).minus(m))
}

export interface ComputeLeverageParams {
  entry: Numeric
  sl: Numeric
  side: Side
  mmr: Numeric
  channelMaxLev: Numeric
  instrMaxLev: Numeric
  leverageStep: Numeric
  /** Буфер на комиссии/проскальзывание/переход MMR-тира. По умолчанию 0.005 (research §6). */
  buf?: Numeric
}

const DEFAULT_BUF = '0.005'

/**
 * Максимально безопасное плечо — такое, чтобы SL сработал РАНЬШЕ цены ликвидации
 * (research §6, ГЛАВНОЕ денежное свойство системы):
 *   d = |entry - sl| / entry                          (stopDistance, по модулю —
 *                                                       одна формула для long и short)
 *   lev_max_safe = 1 / (d + mmr + buf)
 *   lev = clamp( floor_to(leverageStep, lev_max_safe), 1, min(channelMaxLev, instrMaxLev) )
 *
 * `side` в самой формуле не участвует (d берётся по модулю — симметрично для long/short),
 * но обязателен в сигнатуре по контракту задачи: вызывающая сторона передаёт его же
 * в liqPrice() для интерпретации итогового плеча, и на нём же основана gарантия
 * направления (для long ожидается sl < entry, для short — sl > entry; это ответственность
 * вызывающего кода, а не computeLeverage — функция чистая и не валидирует бизнес-инварианты
 * входа, см. property-тест P1 в test/leverage.test.ts).
 */
export function computeLeverage(params: ComputeLeverageParams): Decimal {
  const entry = new Decimal(params.entry)
  const sl = new Decimal(params.sl)
  const mmr = new Decimal(params.mmr)
  const buf = params.buf === undefined ? new Decimal(DEFAULT_BUF) : new Decimal(params.buf)

  const d = sl.minus(entry).abs().div(entry)
  const levMaxSafe = new Decimal(1).div(d.plus(mmr).plus(buf))
  const floored = floorTo(params.leverageStep, levMaxSafe)

  const maxAllowed = Decimal.min(new Decimal(params.channelMaxLev), new Decimal(params.instrMaxLev))
  return Decimal.max(new Decimal(1), Decimal.min(floored, maxAllowed))
}
