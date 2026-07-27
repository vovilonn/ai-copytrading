import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal } from 'decimal.js'
import { computeSize } from '../src/risk/sizing.js'

// Как и в leverage.test.ts — все входы строками (контракт string|Decimal), не JS number.

describe('computeSize', () => {
  it('riskPct=2, equity=1000, entry=1.5004, sl=1.7137 -> notional=(0.02*1000)/d ≈140.6 (research §6/design spec)', () => {
    // Точное значение (decimal.js, без округлений): d=0.14216209010930418555,
    // notional=140.68448195030473512 — совпадает с приближением задачи "≈140.6"
    // (140.684... усекается до 140.6 при округлении вниз до 1 знака).
    const r = computeSize({
      riskPct: '2',
      equity: '1000',
      tradeSize: '999999', // не используется — задан riskPct
      entry: '1.5004',
      sl: '1.7137',
      lev: '10',
      minNotional: '5',
      qtyStep: '0.1',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('140.68448195030473512')
    expect(r.qty.toString()).toBe('93.7')
  })

  // trade_size — МАРЖА (реальные деньги с баланса), а не размер позиции: 200 при плече 10 — это
  // позиция на 2000, из депозита блокируется ровно 200 (решение заказчика 27.07.2026).
  it('без riskPct -> notional = tradeSize * lev, из баланса уходит ровно tradeSize', () => {
    const r = computeSize({
      equity: '1000',
      tradeSize: '200',
      entry: '50',
      sl: '45',
      lev: '10',
      minNotional: '5',
      qtyStep: '0.01',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('2000')
    expect(r.qty.toString()).toBe('40')
    // Маржа = notional/lev — ровно та цифра, которую оператор вписал в настройку.
    expect(r.notional.div(10).toString()).toBe('200')
  })

  it('плечо 1 -> позиция равна trade_size: маржа и размер совпадают', () => {
    const r = computeSize({
      equity: '1000',
      tradeSize: '200',
      entry: '50',
      sl: '45',
      lev: '1',
      minNotional: '5',
      qtyStep: '0.01',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('200')
  })

  it('trade_size больше депозита -> потолок equity*lev не даёт занять маржи больше, чем есть', () => {
    const r = computeSize({
      equity: '100',
      tradeSize: '250', // маржа больше депозита
      entry: '50',
      sl: '45',
      lev: '10',
      minNotional: '5',
      qtyStep: '0.01',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('1000') // = equity*lev, а не 250*10=2500
    expect(r.notional.div(10).toString()).toBe('100') // маржа ровно равна депозиту
  })

  it('maxSymbolNotional урезает notional (потолок задан в размере позиции, не в марже)', () => {
    const r = computeSize({
      equity: '1000',
      tradeSize: '500',
      entry: '50',
      sl: '45',
      lev: '10',
      minNotional: '5',
      maxSymbolNotional: '300',
      qtyStep: '0.01',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('300')
    expect(r.qty.toString()).toBe('6')
  })

  it('equity*lev тоже жёсткий потолок (даже без maxSymbolNotional)', () => {
    const r = computeSize({
      equity: '100',
      tradeSize: '5000',
      entry: '50',
      sl: '45',
      lev: '5', // потолок = 100*5=500 < 5000*5
      minNotional: '5',
      qtyStep: '0.01',
    })
    expect('skip' in r).toBe(false)
    if ('skip' in r) return
    expect(r.notional.toString()).toBe('500')
    expect(r.qty.toString()).toBe('10')
  })

  it('notional < minNotional -> skip(below_min_notional)', () => {
    const r = computeSize({
      equity: '1000',
      tradeSize: '0.4', // маржа 0.4 при плече 10 -> позиция 4 < minNotional 5
      entry: '50',
      sl: '45',
      lev: '10',
      minNotional: '5',
      qtyStep: '0.01',
    })
    expect(r).toEqual({ skip: 'below_min_notional' })
  })

  it('notional проходит минимум, но qty после floor_to(qtyStep) равен нулю -> skip(zero_qty)', () => {
    const r = computeSize({
      equity: '1000',
      tradeSize: '0.6',
      entry: '1',
      sl: '0.9',
      lev: '10',
      minNotional: '5',
      qtyStep: '10', // грубый шаг: notional/entry=6, floor_to(10,6)=0
    })
    expect(r).toEqual({ skip: 'zero_qty' })
  })
})

// P2: qty всегда кратно qtyStep (когда результат не skip).
// P3: notional никогда не превышает min(equity*lev, maxSymbolNotional).
describe('property: computeSize — округление и потолок (P2, P3)', () => {
  it('1000+ случайных валидных входов, сид фиксирован', () => {
    const qtySteps = ['0.0001', '0.001', '0.01', '0.1', '1'] as const

    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), // equity
        fc.double({ min: 1, max: 100_000, noNaN: true, noDefaultInfinity: true }), // tradeSize
        fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), // entry
        fc.double({ min: 0.001, max: 0.9, noNaN: true, noDefaultInfinity: true }), // d (для sl)
        fc.double({ min: 1, max: 125, noNaN: true, noDefaultInfinity: true }), // lev
        fc.option(fc.double({ min: 0.1, max: 100, noNaN: true, noDefaultInfinity: true }), { nil: undefined }), // riskPct?
        fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), // minNotional
        fc.option(fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), { nil: undefined }), // maxSymbolNotional?
        fc.constantFrom(...qtySteps),
        (equityNum, tradeSizeNum, entryNum, d, levNum, riskPctNum, minNotionalNum, maxSymbolNotionalNum, qtyStep) => {
          const equity = new Decimal(equityNum)
          const entry = new Decimal(entryNum)
          const lev = new Decimal(levNum)
          const sl = entry.mul(new Decimal(1).plus(d)) // направление не важно — computeSize берёт |entry-sl|

          const result = computeSize({
            riskPct: riskPctNum?.toString(),
            equity: equity.toString(),
            tradeSize: tradeSizeNum.toString(),
            entry: entry.toString(),
            sl: sl.toString(),
            lev: lev.toString(),
            minNotional: minNotionalNum.toString(),
            maxSymbolNotional: maxSymbolNotionalNum?.toString(),
            qtyStep,
          })

          if ('skip' in result) return // skip — не проверяем P2/P3, проверять нечего

          // P2: qty кратно qtyStep (остаток от деления = 0).
          expect(result.qty.mod(qtyStep).isZero()).toBe(true)

          // P3: notional <= min(equity*lev, maxSymbolNotional?).
          const cap =
            maxSymbolNotionalNum === undefined
              ? equity.mul(lev)
              : Decimal.min(equity.mul(lev), new Decimal(maxSymbolNotionalNum))
          expect(result.notional.lte(cap)).toBe(true)
        },
      ),
      { numRuns: 1000, seed: 20260710 },
    )
  })
})
