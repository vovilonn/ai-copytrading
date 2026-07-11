import { describe, it, expect, vi } from 'vitest'
import { Decimal } from 'decimal.js'
import { getEquity, type EquityRestClient } from '../src/state/equity.js'
import { BybitRestClient } from '../src/bybit/rest-client.js'

// getEquity (Ф3, задача 4; research bybit-execution.md §14) — реальный equity аккаунта из
// wallet-balance вместо хардкода '1000' (см. state/equity.ts топ-комментарий). Группы:
//  1) ЧИСТЫЕ (мок rest, без сети): Decimal из totalEquity, кэш TTL=30с не бьёт rest дважды,
//     forceRefresh игнорирует кэш, параллельные промахи дедуплицируются.
//  2) ЖИВАЯ (BYBIT_LIVE_TESTS=1, тот же гейт, что bybit-rest.test.ts) — реальный testnet-баланс.

function createMockRest(totalEquity: string): { rest: EquityRestClient; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async () => ({ totalEquity, totalAvailableBalance: totalEquity, coins: [] }))
  return { rest: { getWalletBalance: fn }, fn }
}

describe('getEquity (мок rest, без сети)', () => {
  it('возвращает totalEquity как Decimal', async () => {
    const { rest } = createMockRest('999.5')
    const equity = await getEquity(rest)
    expect(equity).toBeInstanceOf(Decimal)
    expect(equity.toString()).toBe('999.5')
  })

  it('кэш не бьёт rest дважды в пределах TTL (30с)', async () => {
    vi.useFakeTimers()
    try {
      const { rest, fn } = createMockRest('1000')
      const first = await getEquity(rest)
      vi.advanceTimersByTime(5_000) // < TTL
      const second = await getEquity(rest)
      expect(second.toString()).toBe(first.toString())
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('истёкший TTL -> следующий вызов бьёт rest снова', async () => {
    vi.useFakeTimers()
    try {
      const { rest, fn } = createMockRest('1000')
      await getEquity(rest)
      vi.advanceTimersByTime(31_000) // > TTL
      await getEquity(rest)
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forceRefresh игнорирует кэш и бьёт rest снова, даже в пределах TTL', async () => {
    const { rest, fn } = createMockRest('1000')
    await getEquity(rest)
    await getEquity(rest, { forceRefresh: true })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('параллельные промахи кэша дедуплицируются в один сетевой вызов', async () => {
    const { rest, fn } = createMockRest('1234.56')
    const [a, b] = await Promise.all([getEquity(rest), getEquity(rest)])
    expect(a.toString()).toBe('1234.56')
    expect(b.toString()).toBe('1234.56')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('разные subaccount кэшируются независимо (резерв под Ф-later)', async () => {
    const { rest, fn } = createMockRest('1000')
    await getEquity(rest, { subaccount: 'ch1' })
    await getEquity(rest, { subaccount: 'ch2' })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('getEquity — Minor M3 адверсариального ревью: пустой totalEquity', () => {
  it('totalEquity="" -> fallback на totalAvailableBalance, не бросает', async () => {
    const fn = vi.fn(async () => ({ totalEquity: '', totalAvailableBalance: '777.5', coins: [] }))
    const equity = await getEquity({ getWalletBalance: fn })
    expect(equity.toString()).toBe('777.5')
  })

  it('totalEquity И totalAvailableBalance оба "" -> fallback на прошлое кэшированное значение', async () => {
    let call = 0
    const fn = vi.fn(async () => {
      call += 1
      // Первый вызов — нормальный ответ (наполняет кэш), второй — оба поля внезапно пусты.
      return call === 1 ? { totalEquity: '1000', totalAvailableBalance: '1000', coins: [] } : { totalEquity: '', totalAvailableBalance: '', coins: [] }
    })
    const rest = { getWalletBalance: fn }
    const first = await getEquity(rest)
    expect(first.toString()).toBe('1000')

    const second = await getEquity(rest, { forceRefresh: true })
    expect(second.toString()).toBe('1000') // прошлое кэшированное значение, не Decimal(NaN)/throw
  })

  it('totalEquity И totalAvailableBalance оба "" И кэша ещё нет (первый вызов процесса) -> бросает явную ошибку', async () => {
    const fn = vi.fn(async () => ({ totalEquity: '', totalAvailableBalance: '', coins: [] }))
    await expect(getEquity({ getWalletBalance: fn })).rejects.toThrow()
  })
})

const BYBIT_LIVE_TESTS = process.env.BYBIT_LIVE_TESTS === '1'
if (!BYBIT_LIVE_TESTS) {
  console.warn('[equity.test] живой Bybit-тест пропущен; задайте BYBIT_LIVE_TESTS=1 для запуска (ходит на testnet)')
}
const describeLive = BYBIT_LIVE_TESTS ? describe : describe.skip

describeLive('getEquity (живой testnet) — требует BYBIT_LIVE_TESTS=1', () => {
  it('возвращает реальный totalEquity аккаунта (~999 USDT, testnet пополнен)', async () => {
    const apiKey = process.env.BYBIT_API_KEY
    const apiSecret = process.env.BYBIT_API_SECRET
    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_LIVE_TESTS=1, но BYBIT_API_KEY/BYBIT_API_SECRET не заданы в .env')
    }
    const network = process.env.BYBIT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    const client = new BybitRestClient({ apiKey, apiSecret, network })

    const equity = await getEquity(client)
    console.log('[live] getEquity() =', equity.toString())
    expect(equity.gte(0)).toBe(true)
  })
})
