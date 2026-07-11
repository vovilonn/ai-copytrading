import { describe, it, expect } from 'vitest'
import { parseNumbers, toNum, splitKeycaps, signedMoney, computeRoi, formatWinRate } from '../src/numbers.js'

describe('parseNumbers', () => {
  it('62 000$ — разделитель тысяч обычный пробел U+0020', () => {
    expect(parseNumbers('62 000$')).toEqual([62000])
  })

  it('диапазон входа через дефис: 1.5273-1.4735', () => {
    expect(parseNumbers('1.5273-1.4735')).toEqual([1.5273, 1.4735])
  })

  it('мелкая монета без разделителей: 0.0014856', () => {
    expect(parseNumbers('0.0014856')).toEqual([0.0014856])
  })

  it('диапазон 1.12-1.125', () => {
    expect(parseNumbers('1.12-1.125')).toEqual([1.12, 1.125])
  })

  it('незначащий нуль в хвосте: 15.920', () => {
    expect(parseNumbers('15.920')).toEqual([15.92])
  })

  it('неразрывный пробел U+00A0 как разделитель тысяч', () => {
    expect(parseNumbers('62\u00A0000$')).toEqual([62000])
  })

  it('узкий неразрывный пробел U+202F как разделитель тысяч', () => {
    expect(parseNumbers('62\u202F000$')).toEqual([62000])
  })

  it('несколько чисел в произвольном тексте', () => {
    expect(parseNumbers('Риск: 2%')).toEqual([2])
  })
})

describe('toNum', () => {
  it('снимает пробел-разделитель тысяч', () => {
    expect(toNum('62 000')).toBe(62000)
  })

  it('десятичная запятая -> точка', () => {
    expect(toNum('0,51396')).toBeCloseTo(0.51396)
  })

  it('десятичная точка без изменений', () => {
    expect(toNum('0.0728')).toBe(0.0728)
  })
})

describe('signedMoney', () => {
  it('положительное -> "+$327.60"', () => {
    expect(signedMoney(327.6)).toBe('+$327.60')
  })

  it('отрицательное -> "-$24.00"', () => {
    expect(signedMoney(-24)).toBe('-$24.00')
  })

  it('ноль -> знак плюс ("+$0.00", design: uPnl>=0 считается зелёным/plus)', () => {
    expect(signedMoney(0)).toBe('+$0.00')
  })

  it('разделитель тысяч у крупных сумм', () => {
    expect(signedMoney(26535)).toBe('+$26,535.00')
  })
})

describe('computeRoi', () => {
  it('pnl=327.6, margin=5307 -> "+6.2%"', () => {
    expect(computeRoi(327.6, 5307)).toBe('+6.2%')
  })

  it('отрицательный pnl -> "-2.2%"', () => {
    expect(computeRoi(-24, 1080)).toBe('-2.2%')
  })

  it('margin<=0 -> "+0.0%" (деление на ноль исключено)', () => {
    expect(computeRoi(100, 0)).toBe('+0.0%')
    expect(computeRoi(100, -5)).toBe('+0.0%')
  })
})

describe('splitKeycaps', () => {
  it('1️⃣80.82️⃣82.33️⃣84 -> [80.8, 82.3, 84]', () => {
    expect(splitKeycaps('1️⃣80.82️⃣82.33️⃣84')).toEqual([80.8, 82.3, 84])
  })

  it('1️⃣742️⃣75.53️⃣77 -> [74, 75.5, 77]', () => {
    expect(splitKeycaps('1️⃣742️⃣75.53️⃣77')).toEqual([74, 75.5, 77])
  })

  it('1️⃣1.0752️⃣1.0953️⃣1.115 -> [1.075, 1.095, 1.115]', () => {
    expect(splitKeycaps('1️⃣1.0752️⃣1.0953️⃣1.115')).toEqual([1.075, 1.095, 1.115])
  })
})

describe('formatWinRate', () => {
  it('closedTrades=0 -> "—" (нет закрытых сделок, не "0%")', () => {
    expect(formatWinRate(0, 0)).toBe('—')
  })

  it('2 победы из 3 закрытых -> округление 66.67 -> "67%"', () => {
    expect(formatWinRate(3, 2)).toBe('67%')
  })

  it('0 побед из закрытых -> "0%"', () => {
    expect(formatWinRate(5, 0)).toBe('0%')
  })

  it('все закрытые прибыльны -> "100%"', () => {
    expect(formatWinRate(4, 4)).toBe('100%')
  })
})
