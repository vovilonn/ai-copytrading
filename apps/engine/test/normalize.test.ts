import { describe, it, expect } from 'vitest'
import { normalize } from '../src/normalize.js'
import { parseNumbers, splitKeycaps } from 'shared/numbers.js'

describe('normalize', () => {
  it('приводит к нижнему регистру', () => {
    expect(normalize('Пробую с текущих Лонг битка')).toBe('пробую с текущих лонг битка')
  })

  it('э -> е (тэйк -> тейк, research §7 E5)', () => {
    expect(normalize('Первый тэйк 60400')).toBe('первый тейк 60400')
  })

  it('ё -> е (объём -> объем)', () => {
    expect(normalize('Один объём закрыт')).toBe('один объем закрыт')
  })

  it('обрезает края', () => {
    expect(normalize('  Лонг  ')).toBe('лонг')
  })

  it('схлопывает повторяющиеся пробелы в один', () => {
    expect(normalize('Sol   limit   long   67.7')).toBe('sol limit long 67.7')
  })

  it('не трогает keycap-эмодзи — splitKeycaps работает и после normalize()', () => {
    // Строка — уже изолированный фрагмент целей (как после /Targets?:\s*([^\n]+)/
    // в адаптере, задача 3); normalize() не должен покорёжить keycap-последовательности.
    const t = normalize('1️⃣80.82️⃣82.33️⃣84')
    expect(splitKeycaps(t)).toEqual([80.8, 82.3, 84])
  })

  it('схлопывание пробелов сводит nbsp/narrow-nbsp к U+0020 — parseNumbers остаётся рабочим', () => {
    // 62 000$ — разделитель тысяч неразрывный пробел (как в WEEX-скринах),
    // после normalize() он становится обычным U+0020, который NUM и так распознаёт.
    expect(parseNumbers(normalize('62\u00A0000$'))).toEqual([62000])
  })
})
