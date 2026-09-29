import { describe, it, expect } from 'vitest'
import { Decimal } from 'decimal.js'
import { computeLeverage, liqPrice } from '../src/risk/leverage.js'
import { leverageWithoutSl, protectiveSl, refreshedProtectiveSl } from '../src/risk/protective-sl.js'

// Защитный стоп для входа БЕЗ стопа («Long BTC с текущих»). Денежное свойство системы: позиция на
// плече не должна ни секунды висеть без защиты, а сам стоп обязан срабатывать РАНЬШЕ ликвидации —
// иначе он не защищает, а лишь создаёт её видимость.

const MMR = '0.005'
const STEP = '0.01'

describe('protectiveSl — инверсия computeLeverage', () => {
  // Ключевой инвариант: стоп выводится из плеча ТОЙ ЖЕ формулой, что плечо выводится из стопа.
  // Если инверсия неточна, существующий гейт safeStop (pipeline) начнёт врать на синтетическом стопе.
  it('обратный computeLeverage возвращает ИСХОДНОЕ плечо (long и short, плечи 1..50)', () => {
    for (const lev of [1, 2, 3, 5, 10, 20, 25, 50]) {
      for (const side of ['long', 'short'] as const) {
        const sl = protectiveSl({ entry: '100000', side, lev: String(lev), mmr: MMR })
        expect(sl, `lev=${lev} ${side}: стоп должен существовать`).not.toBeNull()

        const back = computeLeverage({
          entry: '100000',
          sl: sl!.toString(),
          side,
          mmr: MMR,
          channelMaxLev: '100',
          instrMaxLev: '100',
          leverageStep: STEP,
        })
        expect(back.toNumber(), `lev=${lev} ${side}`).toBeCloseTo(lev, 6)
      }
    }
  })

  // Главное денежное свойство: SL строго перед ликвидацией.
  it('стоп срабатывает РАНЬШЕ ликвидации (long: sl > liq; short: sl < liq)', () => {
    for (const lev of [2, 5, 10, 20, 50]) {
      const long = protectiveSl({ entry: '100000', side: 'long', lev: String(lev), mmr: MMR })!
      const longLiq = liqPrice({ entry: '100000', side: 'long', lev: String(lev), mmr: MMR })
      expect(long.gt(longLiq), `long lev=${lev}: sl=${long} liq=${longLiq}`).toBe(true)

      const short = protectiveSl({ entry: '100000', side: 'short', lev: String(lev), mmr: MMR })!
      const shortLiq = liqPrice({ entry: '100000', side: 'short', lev: String(lev), mmr: MMR })
      expect(short.lt(shortLiq), `short lev=${lev}: sl=${short} liq=${shortLiq}`).toBe(true)
    }
  })

  it('стоп с нужной стороны от входа: long — ниже, short — выше', () => {
    const long = protectiveSl({ entry: '100', side: 'long', lev: '10', mmr: MMR })!
    const short = protectiveSl({ entry: '100', side: 'short', lev: '10', mmr: MMR })!
    expect(long.lt(100)).toBe(true)
    expect(short.gt(100)).toBe(true)
  })

  // При 10x стоп встаёт на 9% от входа: d = 1/10 − 0.005 (mmr) − 0.005 (буфер) = 0.09.
  it('дистанция стопа = 1/плечо − mmr − буфер (10x → 9% от входа)', () => {
    const sl = protectiveSl({ entry: '100000', side: 'long', lev: '10', mmr: MMR })!
    expect(sl.toString()).toBe('91000')

    const sl20 = protectiveSl({ entry: '100000', side: 'long', lev: '20', mmr: MMR })!
    expect(sl20.toString()).toBe('96000') // 20x → 4%: выше плечо — ближе стоп
  })

  // Плечо настолько велико, что 1/lev не покрывает даже mmr+буфер: «стоп» совпал бы с ликвидацией.
  // Такой вход обязан быть пропущен, а не исполнен без реальной защиты.
  it('плечо 100x при mmr=0.005 -> null (стоп схлопнулся бы в ликвидацию)', () => {
    expect(protectiveSl({ entry: '100000', side: 'long', lev: '100', mmr: MMR })).toBeNull()
    expect(protectiveSl({ entry: '100000', side: 'short', lev: '200', mmr: MMR })).toBeNull()
  })
})

describe('leverageWithoutSl — плечо, когда стопа нет', () => {
  it('берёт default_leverage канала', () => {
    const lev = leverageWithoutSl({ defaultLev: '10', channelMaxLev: '20', instrMaxLev: '100', leverageStep: STEP })
    expect(lev.toString()).toBe('10')
  })

  it('default_leverage не задан -> потолок канала', () => {
    const lev = leverageWithoutSl({ defaultLev: null, channelMaxLev: '20', instrMaxLev: '100', leverageStep: STEP })
    expect(lev.toString()).toBe('20')
  })

  it('клампится потолком канала и потолком инструмента', () => {
    expect(
      leverageWithoutSl({ defaultLev: '50', channelMaxLev: '20', instrMaxLev: '100', leverageStep: STEP }).toString(),
    ).toBe('20') // канал не разрешает больше 20
    expect(
      leverageWithoutSl({ defaultLev: '50', channelMaxLev: '100', instrMaxLev: '25', leverageStep: STEP }).toString(),
    ).toBe('25') // биржа не разрешает больше 25 по этому символу
  })

  it('никогда не меньше 1', () => {
    const lev = leverageWithoutSl({ defaultLev: '0', channelMaxLev: '20', instrMaxLev: '100', leverageStep: STEP })
    expect(lev.gte(new Decimal(1))).toBe(true)
  })
})

// Живой случай 29.09.2026 (TR-1120, 1000PEPE): вход 0.00444 → защитный стоп 0.004064; доливка по
// 0.0041 удвоила позицию, а стоп остался на месте — в 0.9% под ценой доливки — и выбил ВЕСЬ объём
// (−68.67$). Защитный стоп обязан переезжать вслед за средней ценой позиции.
describe('refreshedProtectiveSl — стоп переезжает за средней ценой после доливки', () => {
  const BASE = { side: 'long' as const, lev: '10', mmr: MMR, tickSize: '0.000001' }

  it('доливка НИЖЕ входа опускает стоп (живой случай pepe)', () => {
    const moved = refreshedProtectiveSl({
      ...BASE,
      avgPrice: '0.00426322', // средняя после доливки 0.0041 к входу 0.00444
      currentSl: '0.004064', // посчитан от ПЕРВОГО входа
      markPrice: '0.00421',
    })

    expect(moved).not.toBeNull()
    // Та же формула, что и при открытии: d = 1/lev − mmr − buf = 9% от средней.
    expect(moved!.toFixed(6)).toBe(new Decimal('0.00426322').mul('0.91').toDP(6, Decimal.ROUND_DOWN).toFixed(6))
    expect(moved!.lt('0.004064')).toBe(true)
  })

  it('доливка ВЫШЕ входа поднимает стоп: иначе он окажется за ценой ликвидации', () => {
    const moved = refreshedProtectiveSl({ ...BASE, avgPrice: '110', currentSl: '91.5', markPrice: '112', tickSize: '0.01' })

    expect(moved).not.toBeNull()
    expect(moved!.gt('91.5')).toBe(true)
  })

  it('средняя не изменилась — стоп не трогаем (нет ордера на биржу)', () => {
    const sl = protectiveSl({ entry: '100', side: 'long', lev: '10', mmr: MMR })!
    expect(refreshedProtectiveSl({ ...BASE, avgPrice: '100', currentSl: sl.toString(), markPrice: '101', tickSize: '0.01' })).toBeNull()
  })

  it('новый стоп оказался бы ВЫШЕ рынка — не двигаем (это закрыло бы позицию немедленно)', () => {
    // Позиция глубоко в минусе: средняя 110, рынок 95 — пересчитанный стоп 100.6 выше рынка.
    expect(refreshedProtectiveSl({ ...BASE, avgPrice: '110', currentSl: '91.5', markPrice: '95', tickSize: '0.01' })).toBeNull()
  })

  it('шорт: зеркально — стоп выше средней и должен остаться выше рынка', () => {
    const moved = refreshedProtectiveSl({ ...BASE, side: 'short', avgPrice: '90', currentSl: '109', markPrice: '89', tickSize: '0.01' })

    expect(moved).not.toBeNull()
    expect(moved!.lt('109')).toBe(true)
    expect(moved!.gt('89')).toBe(true)
  })

  it('стопа на позиции НЕТ — не ставим его заново (его сняли намеренно)', () => {
    expect(refreshedProtectiveSl({ ...BASE, avgPrice: '100', currentSl: null, markPrice: '101', tickSize: '0.01' })).toBeNull()
    expect(refreshedProtectiveSl({ ...BASE, avgPrice: '100', currentSl: '0', markPrice: '101', tickSize: '0.01' })).toBeNull()
  })

  it('без средней цены или без плеча пересчёта нет', () => {
    expect(refreshedProtectiveSl({ ...BASE, avgPrice: '0', currentSl: '1', markPrice: '1' })).toBeNull()
    expect(refreshedProtectiveSl({ ...BASE, lev: '0', avgPrice: '100', currentSl: '91', markPrice: '101' })).toBeNull()
  })
})
