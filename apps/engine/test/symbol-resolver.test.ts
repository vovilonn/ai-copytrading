import { describe, it, expect } from 'vitest'
import { resolveSymbol, extractSide, extractCoins } from '../src/symbol-resolver.js'

const alwaysListed = () => true
const neverListed = () => false

describe('resolveSymbol — стем-мап кириллица (research §9)', () => {
  it('битка -> BTCUSDT', () => {
    expect(resolveSymbol('битка', alwaysListed)).toBe('BTCUSDT')
  })

  it('битку -> BTCUSDT', () => {
    expect(resolveSymbol('битку', alwaysListed)).toBe('BTCUSDT')
  })

  it('битке -> BTCUSDT', () => {
    expect(resolveSymbol('битке', alwaysListed)).toBe('BTCUSDT')
  })

  it('эфира -> ETHUSDT', () => {
    expect(resolveSymbol('эфира', alwaysListed)).toBe('ETHUSDT')
  })

  it('солане -> SOLUSDT', () => {
    expect(resolveSymbol('солане', alwaysListed)).toBe('SOLUSDT')
  })

  it('рипл -> XRPUSDT', () => {
    expect(resolveSymbol('рипл', alwaysListed)).toBe('XRPUSDT')
  })

  it('дога -> DOGEUSDT', () => {
    expect(resolveSymbol('дога', alwaysListed)).toBe('DOGEUSDT')
  })
})

describe('resolveSymbol — хэштег #TICKER(/USDT)? (research §9)', () => {
  it('#GRASS/USDT -> GRASSUSDT', () => {
    expect(resolveSymbol('#GRASS/USDT', alwaysListed)).toBe('GRASSUSDT')
  })

  it('#O -> OUSDT', () => {
    expect(resolveSymbol('#O', alwaysListed)).toBe('OUSDT')
  })

  it('#PUMPFUN -> PUMPFUNUSDT (не PUMPUSDT, research §8)', () => {
    expect(resolveSymbol('#PUMPFUN', alwaysListed)).toBe('PUMPFUNUSDT')
  })
})

describe('resolveSymbol — гейт по листингу (research §8)', () => {
  it('GRASSUSDT без листинга -> null', () => {
    expect(resolveSymbol('GRASSUSDT', neverListed)).toBeNull()
  })

  it('символ найден (#GRASS/USDT), но isListed=false -> null', () => {
    expect(resolveSymbol('#GRASS/USDT', neverListed)).toBeNull()
  })

  it('символ найден (стем-мап), но isListed=false -> null', () => {
    expect(resolveSymbol('битка', neverListed)).toBeNull()
  })

  it('символ не распознан вовсе -> null, isListed не должен решать исход', () => {
    expect(resolveSymbol('случайный текст без монет', alwaysListed)).toBeNull()
  })
})

describe('extractSide — маркеры направления (research §4)', () => {
  it('#GRASS/USDT 📉SHORT -> short', () => {
    expect(extractSide('#GRASS/USDT 📉SHORT')).toBe('short')
  })

  it('📈 LONG -> long', () => {
    expect(extractSide('📈 LONG')).toBe('long')
  })

  it('Пробую с текущих Лонг битка -> long', () => {
    expect(extractSide('Пробую с текущих Лонг битка')).toBe('long')
  })

  it('Перезахожу в Лонги Sol Eth btc -> long', () => {
    expect(extractSide('Перезахожу в Лонги Sol Eth btc')).toBe('long')
  })

  it('Relong -> long', () => {
    expect(extractSide('Relong')).toBe('long')
  })

  it('Шорт -> short', () => {
    expect(extractSide('Шорт')).toBe('short')
  })

  it('текст без маркеров направления -> null', () => {
    expect(extractSide('Диапазон входа: 1.5273-1.4735')).toBeNull()
  })

  it('КРИТИЧНО: монета в шортовом брейкере -> null (не ложный short)', () => {
    expect(extractSide('монета в шортовом брейкере')).toBeNull()
  })

  it('заманить в шорт трейдеров -> short: "шорт" как ЦЕЛОЕ слово матчится (в отличие от префикса "шортовом"); что всё сообщение в целом NOISE (research §5, msg 221351) — решает адаптер канала (задача 3), не эта функция', () => {
    expect(extractSide('заманить в шорт трейдеров')).toBe('short')
  })
})

describe('extractCoins — все коин-слова из текста (research §4/§9)', () => {
  it('цена в битке консолидируется -> [BTC] (контекст-аналитика — фильтрация не забота этой функции)', () => {
    expect(extractCoins('цена в битке консолидируется')).toEqual(['BTC'])
  })

  it('Перезахожу в Лонги Sol Eth btc -> [SOL, ETH, BTC]', () => {
    expect(extractCoins('Перезахожу в Лонги Sol Eth btc')).toEqual(['SOL', 'ETH', 'BTC'])
  })

  it('без коин-слов -> []', () => {
    expect(extractCoins('монета в шортовом брейкере')).toEqual([])
  })

  it('дедуп: повторное упоминание одной монеты не дублируется', () => {
    expect(extractCoins('битка выросла, битка снова в деле')).toEqual(['BTC'])
  })
})
