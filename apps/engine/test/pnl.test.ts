import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Decimal } from 'decimal.js'
import type { Side } from 'shared/domain.js'
import { computeUnrealisedPnl } from '../src/market-data/pnl.js'

// Формула PnL (task-10-brief.md): long (mark−avg)·size, short (avg−mark)·size — числовая
// проверка на конкретных значениях + property-тест на знак прибыли/убытка.

describe('computeUnrealisedPnl', () => {
  it('long в плюсе: mark > avg -> положительный PnL', () => {
    const pnl = computeUnrealisedPnl('long', '0.42', '62400', '63180')
    // (63180-62400)*0.42 = 327.6
    expect(pnl.toString()).toBe('327.6')
  })

  it('long в минусе: mark < avg -> отрицательный PnL', () => {
    const pnl = computeUnrealisedPnl('long', '40', '27.00', '26.40')
    // (26.40-27.00)*40 = -24
    expect(pnl.toString()).toBe('-24')
  })

  it('short в плюсе: mark < avg -> положительный PnL', () => {
    const pnl = computeUnrealisedPnl('short', '120', '148.0', '143.2')
    // (148.0-143.2)*120 = 576
    expect(pnl.toString()).toBe('576')
  })

  it('short в минусе: mark > avg -> отрицательный PnL', () => {
    const pnl = computeUnrealisedPnl('short', '3000', '0.6200', '0.6310')
    // (0.6200-0.6310)*3000 = -33
    expect(pnl.toString()).toBe('-33')
  })

  it('mark === avg -> ровно ноль (обе стороны)', () => {
    expect(computeUnrealisedPnl('long', '10', '100', '100').isZero()).toBe(true)
    expect(computeUnrealisedPnl('short', '10', '100', '100').isZero()).toBe(true)
  })

  // Property: знак PnL всегда согласован с направлением движения цены относительно входа —
  // long зарабатывает когда mark>avg, short — когда mark<avg, симметрично для убытка.
  it('property: sign(pnl) согласован с направлением и стороной (1000 случайных входов)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        // |relMove| > 1e-6: fast-check иначе находит денормализованные double вроде 5e-324 —
        // на дефолтной точности decimal.js (20 значащих цифр) 1+5e-324 округляется обратно в
        // ровно 1 (сдвиг на 324-м знаке после запятой не влезает в 20 значащих цифр), mark==avg
        // и тест не про формулу, а про артефакт округления такой микроскопической дельты.
        fc.double({ min: -0.5, max: 0.5, noNaN: true, noDefaultInfinity: true }).filter((d) => Math.abs(d) > 1e-6),
        fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom<Side>('long', 'short'),
        (avgNum, relMove, sizeNum, side) => {
          const avg = new Decimal(avgNum)
          const mark = avg.mul(new Decimal(1).plus(relMove))
          const pnl = computeUnrealisedPnl(side, sizeNum.toString(), avg.toString(), mark.toString())

          const priceWentUp = relMove > 0
          const expectProfit = side === 'long' ? priceWentUp : !priceWentUp
          expect(pnl.gt(0)).toBe(expectProfit)
        },
      ),
      { numRuns: 1000, seed: 20260710 },
    )
  })
})
