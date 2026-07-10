import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { Decimal } from 'decimal.js'
import { liqPrice, computeLeverage, floorTo } from '../src/risk/leverage.js'
import type { Side } from 'shared/domain.js'

// Все входы функций — string|Decimal (контракт денежной математики), поэтому в тестах
// числа передаются строками, а не JS number — это часть проверяемого API, не формальность.

describe('floorTo', () => {
  it('округляет вниз к шагу (не вверх — иначе плечо/qty могли бы превысить безопасный/доступный предел)', () => {
    expect(floorTo('0.01', '6.5719').toString()).toBe('6.57')
    expect(floorTo('1', '6.99').toString()).toBe('6')
    expect(floorTo('0.1', '1.99').toString()).toBe('1.9')
  })

  it('точное попадание на шаг не теряет значение', () => {
    expect(floorTo('0.5', '2.5').toString()).toBe('2.5')
  })
})

describe('liqPrice', () => {
  // Численная проверка research bybit-execution.md §6 — дословный пример Bybit HC.
  it('short: entry=70000, lev=10, mmr=0.005 -> 76650', () => {
    const r = liqPrice({ entry: '70000', side: 'short', lev: '10', mmr: '0.005' })
    expect(r.toString()).toBe('76650')
  })

  it('long: entry=70000, lev=10, mmr=0.005 -> 63350', () => {
    const r = liqPrice({ entry: '70000', side: 'long', lev: '10', mmr: '0.005' })
    expect(r.toString()).toBe('63350')
  })
})

describe('computeLeverage', () => {
  // LIT short, ch-2088626562 #2796 (research §6): entry — середина диапазона входа.
  const litEntry = new Decimal('1.5273').plus('1.4735').div(2) // 1.5004
  const litSl = '1.7137'

  it(
    'LIT short: entry≈1.5004, sl=1.7137, mmr=0.005, buf=0.005, leverageStep=0.01 (реальный шаг ' +
      'Bybit, см. research §7 «leverage: кратно leverageStep=0.01») -> 6.57',
    () => {
      // СОМНЕНИЕ (см. p1-task4-report.md): research §6 в прозе округляет итог до "floor→6×",
      // но это концептуальное упрощение автора доки, а не результат применения формулы
      // floor_to(leverageStep, ...) с реальным leverageStep=0.01, который §7 того же
      // документа называет общим для всех символов. Пересчитано вручную (decimal.js,
      // без округлений): d=0.14216209010930418555, lev_max_safe=6.571939168827528208,
      // floor_to(0.01, 6.5719...) = 6.57 — математически точное значение, не 6.
      // Следующий тест ниже воспроизводит буквально "floor→6×" при leverageStep=1.
      const lev = computeLeverage({
        entry: litEntry.toString(),
        sl: litSl,
        side: 'short',
        mmr: '0.005',
        channelMaxLev: '10',
        instrMaxLev: '100',
        leverageStep: '0.01',
        buf: '0.005',
      })
      expect(lev.toString()).toBe('6.57')
    },
  )

  it('тот же вход при целочисленном leverageStep=1 даёт ровно 6× — так, как описано в §6 прозой', () => {
    const lev = computeLeverage({
      entry: litEntry.toString(),
      sl: litSl,
      side: 'short',
      mmr: '0.005',
      channelMaxLev: '10',
      instrMaxLev: '100',
      leverageStep: '1',
      buf: '0.005',
    })
    expect(lev.toString()).toBe('6')
  })

  it('buf по умолчанию — 0.005 (совпадает с явным buf=0.005)', () => {
    const withDefault = computeLeverage({
      entry: litEntry.toString(),
      sl: litSl,
      side: 'short',
      mmr: '0.005',
      channelMaxLev: '10',
      instrMaxLev: '100',
      leverageStep: '0.01',
    })
    const withExplicit = computeLeverage({
      entry: litEntry.toString(),
      sl: litSl,
      side: 'short',
      mmr: '0.005',
      channelMaxLev: '10',
      instrMaxLev: '100',
      leverageStep: '0.01',
      buf: '0.005',
    })
    expect(withDefault.toString()).toBe(withExplicit.toString())
  })

  it('зажимает сверху по channelMaxLev, если безопасное плечо больше лимита канала', () => {
    // entry=100, sl=99 (long, d=0.01), mmr=0.005, buf=0.005 -> lev_max_safe=1/0.02=50.
    const lev = computeLeverage({
      entry: '100',
      sl: '99',
      side: 'long',
      mmr: '0.005',
      channelMaxLev: '5',
      instrMaxLev: '100',
      leverageStep: '1',
      buf: '0.005',
    })
    expect(lev.toString()).toBe('5')
  })

  it('зажимает сверху по instrMaxLev, если он строже channelMaxLev', () => {
    const lev = computeLeverage({
      entry: '100',
      sl: '99',
      side: 'long',
      mmr: '0.005',
      channelMaxLev: '100',
      instrMaxLev: '3',
      leverageStep: '1',
      buf: '0.005',
    })
    expect(lev.toString()).toBe('3')
  })

  it('зажимает снизу минимумом 1x, если стоп настолько далёк, что безопасное плечо < 1', () => {
    // entry=100, sl=0.5 (long, d=0.995), mmr=0.005, buf=0.005 -> lev_max_safe=1/(0.995+0.01)≈0.995 < 1.
    const lev = computeLeverage({
      entry: '100',
      sl: '0.5',
      side: 'long',
      mmr: '0.005',
      channelMaxLev: '10',
      instrMaxLev: '100',
      leverageStep: '1',
      buf: '0.005',
    })
    expect(lev.toString()).toBe('1')
  })
})

// P1 — ГЛАВНОЕ денежное свойство: бот не должен ликвидироваться раньше, чем сработает стоп.
// Домен генератора: stopDistance d намеренно ограничен диапазоном (0.01, 0.5) — 1..50% от
// entry. Это не искусственное сужение "под тест", а формальная граница применимости самой
// формулы: lev_max_safe = 1/(d+mmr+buf) остаётся строго больше 1 только пока d+mmr+buf < 1.
// При max(mmr)=0.02 и buf=0.005 (дефолт, не рандомизируем) это даёт d < 0.975 — наш верхний
// предел 0.5 взят с большим запасом (реалистичный SL реже 50% от входа). Если бы d уходил
// в эту область (d+mmr+buf ≥ 1), clamp'а нижней границы (лев >= 1x) не хватило бы, чтобы
// удержать инвариант «liq за SL» — это фиксируется как известное ограничение в отчёте, а не
// баг: 1x — минимальное доступное на бирже плечо, ниже физически не опуститься.
describe('property: liqPrice(computeLeverage(...)) всегда за SL (P1)', () => {
  it('long: liq < sl; short: liq > sl — 1000+ случайных валидных входов, сид фиксирован', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true }), // entry
        fc.constantFrom<Side>('long', 'short'),
        fc.double({ min: 0.01, max: 0.5, noNaN: true, noDefaultInfinity: true }), // d = stopDistance
        fc.double({ min: 0.001, max: 0.02, noNaN: true, noDefaultInfinity: true }), // mmr
        fc.double({ min: 2, max: 50, noNaN: true, noDefaultInfinity: true }), // channelMaxLev
        fc.double({ min: 1, max: 125, noNaN: true, noDefaultInfinity: true }), // instrMaxLev
        fc.constantFrom('0.01', '0.1', '1'), // leverageStep — реальные гранулярности Bybit
        (entryNum, side, d, mmrNum, channelMaxLevNum, instrMaxLevNum, leverageStep) => {
          const entry = new Decimal(entryNum)
          const mmr = mmrNum.toString()
          const sl = side === 'long' ? entry.mul(new Decimal(1).minus(d)) : entry.mul(new Decimal(1).plus(d))

          const lev = computeLeverage({
            entry: entry.toString(),
            sl: sl.toString(),
            side,
            mmr,
            channelMaxLev: channelMaxLevNum.toString(),
            instrMaxLev: instrMaxLevNum.toString(),
            leverageStep,
          })

          const liq = liqPrice({ entry: entry.toString(), side, lev, mmr })

          if (side === 'long') {
            expect(liq.lt(sl)).toBe(true)
          } else {
            expect(liq.gt(sl)).toBe(true)
          }
        },
      ),
      { numRuns: 1000, seed: 20260710 }, // фиксированный сид — воспроизводимость между прогонами
    )
  })
})
