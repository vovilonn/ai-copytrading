import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { BybitApiError, BybitRestClient, TokenBucket, signPayload } from '../src/bybit/rest-client.js'

// Тесты Bybit REST-клиента (Ф3, задача 1). Группы:
//  1) ЖИВЫЕ (READ-only + идемпотентный setLeverage) против testnet — гейт BYBIT_LIVE_TESTS=1
//     (тот же приём, что AI_LIVE_TESTS в ai-client.test.ts: явный opt-in, без флага —
//     describe.skip + console.warn, чтобы обычный `pnpm test` не жёг живой Bybit).
//  2) ЧИСТЫЕ: HMAC-подпись детерминирована (эталон посчитан вручную), токен-бакет
//     ограничивает частоту (vi.useFakeTimers), идемпотентные коды 110043/110072 не бросают,
//     прочий ненулевой retCode бросает BybitApiError, retCode 10006 ждёт reset и ретраит.

const BYBIT_LIVE_TESTS = process.env.BYBIT_LIVE_TESTS === '1'
if (!BYBIT_LIVE_TESTS) {
  console.warn('[bybit-rest.test] живые Bybit-тесты пропущены; задайте BYBIT_LIVE_TESTS=1 для запуска (ходит на testnet)')
}
const describeLive = BYBIT_LIVE_TESTS ? describe : describe.skip

/** Мок ответа Bybit — реальный глобальный `Response` (Node 22 fetch API), не самодельный объект. */
function mockResponse(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers: opts.headers })
}

describeLive('BybitRestClient (живой testnet) — требует BYBIT_LIVE_TESTS=1', () => {
  let client: BybitRestClient

  beforeAll(() => {
    const apiKey = process.env.BYBIT_API_KEY
    const apiSecret = process.env.BYBIT_API_SECRET
    const network = process.env.BYBIT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_LIVE_TESTS=1, но BYBIT_API_KEY/BYBIT_API_SECRET не заданы в .env')
    }
    client = new BybitRestClient({ apiKey, apiSecret, network })
  })

  it('getWalletBalance() → totalEquity > 0 (баланс пополнен), подпись верна (retCode 0)', async () => {
    const balance = await client.getWalletBalance()
    console.log('[live] getWalletBalance() =', JSON.stringify(balance))
    expect(Number(balance.totalEquity)).toBeGreaterThan(0)
  })

  it('getPositions() → массив (может быть пуст)', async () => {
    const positions = await client.getPositions()
    console.log('[live] getPositions() count=%d', positions.length)
    expect(Array.isArray(positions)).toBe(true)
  })

  it('getOpenOrders() → массив (может быть пуст)', async () => {
    const orders = await client.getOpenOrders()
    console.log('[live] getOpenOrders() count=%d', orders.length)
    expect(Array.isArray(orders)).toBe(true)
  })

  it('setLeverage(BTCUSDT, текущее плечо) → {ok:true, idempotent:true} (110043 проглочен)', async () => {
    // Стаб-позиция BTCUSDT есть даже при size=0 (research §1) — leverage читается без открытой позиции.
    const positions = await client.getPositions('BTCUSDT')
    const current = positions[0]?.leverage
    expect(current, 'ожидали строку leverage в стаб-позиции BTCUSDT').toBeDefined()

    const result = await client.setLeverage('BTCUSDT', current!)
    console.log('[live] setLeverage(BTCUSDT, %s) =', current, result)
    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(true)
  })
})

describe('signPayload (HMAC-подпись) — детерминизм', () => {
  it('совпадает с эталоном, посчитанным вручную через node:crypto', () => {
    const apiSecret = 'test-secret-abc123'
    const timestamp = '1700000000000'
    const apiKey = 'test-api-key'
    const recvWindow = '5000'
    const queryString = 'category=linear&symbol=BTCUSDT'

    const expected = createHmac('sha256', apiSecret)
      .update(`${timestamp}${apiKey}${recvWindow}${queryString}`)
      .digest('hex')

    expect(signPayload(apiSecret, timestamp, apiKey, recvWindow, queryString)).toBe(expected)
    // Детерминированность: тот же вход → та же подпись при повторном вызове.
    expect(signPayload(apiSecret, timestamp, apiKey, recvWindow, queryString)).toBe(expected)
  })

  it('разные входы дают разные подписи', () => {
    const sig1 = signPayload('secret', '1', 'key', '5000', 'a=1')
    const sig2 = signPayload('secret', '2', 'key', '5000', 'a=1')
    expect(sig1).not.toBe(sig2)
  })
})

describe('TokenBucket (rate-limiter токен-бакет)', () => {
  it('ограничивает частоту — запрос сверх ёмкости ждёт пополнения (vi.useFakeTimers)', async () => {
    vi.useFakeTimers()
    try {
      // capacity=2, 2 токена/с — первые 2 take() решаются немедленно, третий обязан ждать ~500мс.
      const bucket = new TokenBucket(2, 2)
      await bucket.take()
      await bucket.take()

      let resolved = false
      const pending = bucket.take().then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(100)
      expect(resolved).toBe(false) // токенов ещё нет — не должен пройти раньше времени

      await vi.advanceTimersByTimeAsync(500)
      await pending
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('после исчерпания ёмкости расходует ровно по одному токену за такт', async () => {
    vi.useFakeTimers()
    try {
      const bucket = new TokenBucket(1, 1) // 1 токен/с
      await bucket.take() // сразу расходует единственный токен

      const order: number[] = []
      const p1 = bucket.take().then(() => order.push(1))
      const p2 = bucket.take().then(() => order.push(2))

      await vi.advanceTimersByTimeAsync(1000)
      await p1
      expect(order).toEqual([1])

      await vi.advanceTimersByTimeAsync(1000)
      await p2
      expect(order).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('BybitRestClient — идемпотентные/ошибочные retCode (мок fetch, без сети)', () => {
  const originalFetch = global.fetch

  function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
    global.fetch = impl
    return fn().finally(() => {
      global.fetch = originalFetch
    })
  }

  it('setLeverage: retCode 110043 (плечо не изменилось) → {ok:true, idempotent:true}, не бросает', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const result = await withMockFetch(
      (async () => mockResponse({ retCode: 110043, retMsg: 'Set leverage has not been modified', result: {} })) as typeof fetch,
      () => client.setLeverage('BTCUSDT', '10'),
    )
    expect(result).toEqual({ ok: true, idempotent: true })
  })

  it('createOrder: retCode 110072 (дубль orderLinkId) → {ok:true, idempotent:true}, не бросает', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const result = await withMockFetch(
      (async () => mockResponse({ retCode: 110072, retMsg: 'OrderLinkedID is duplicate', result: {} })) as typeof fetch,
      () =>
        client.createOrder({
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.001',
          orderLinkId: 'D01-1-00-E0',
        }),
    )
    expect(result).toEqual({ orderId: '', orderLinkId: 'D01-1-00-E0', ok: true, idempotent: true })
  })

  it('createOrder: успех (retCode 0) → ok:true, idempotent:false, orderId из ответа', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const result = await withMockFetch(
      (async () => mockResponse({ retCode: 0, retMsg: 'OK', result: { orderId: 'abc-123', orderLinkId: 'D01-1-00-E0' } })) as typeof fetch,
      () =>
        client.createOrder({
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.001',
          orderLinkId: 'D01-1-00-E0',
        }),
    )
    expect(result).toEqual({ orderId: 'abc-123', orderLinkId: 'D01-1-00-E0', ok: true, idempotent: false })
  })

  it('прочий ненулевой retCode (напр. 10001) бросает BybitApiError с retCode/retMsg, не ретраит бесконечно', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let calls = 0
    await expect(
      withMockFetch(
        (async () => {
          calls++
          return mockResponse({ retCode: 10001, retMsg: 'params error', result: {} })
        }) as typeof fetch,
        () => client.setLeverage('BTCUSDT', '10'),
      ),
    ).rejects.toMatchObject({ retCode: 10001, retMsg: 'params error' })
    expect(calls).toBe(1) // не-идемпотентный ненулевой retCode — без ретрая, одна попытка
  })

  it('прочий ненулевой retCode — экземпляр BybitApiError', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    await withMockFetch(
      (async () => mockResponse({ retCode: 10004, retMsg: 'sign error', result: {} })) as typeof fetch,
      async () => {
        try {
          await client.getWalletBalance()
          throw new Error('ожидали throw')
        } catch (err) {
          expect(err).toBeInstanceOf(BybitApiError)
        }
      },
    )
  })

  it('retCode 10006 (rate limit UID) → ждёт до X-Bapi-Limit-Reset-Timestamp и повторяет успешно', async () => {
    vi.useFakeTimers()
    try {
      const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
      const resetAt = Date.now() + 300
      let call = 0
      global.fetch = (async () => {
        call++
        if (call === 1) {
          return mockResponse(
            { retCode: 10006, retMsg: 'too many visits', result: {} },
            { headers: { 'X-Bapi-Limit-Reset-Timestamp': String(resetAt) } },
          )
        }
        return mockResponse({
          retCode: 0,
          retMsg: 'OK',
          result: { list: [{ totalEquity: '999.5', totalAvailableBalance: '999.5', coin: [] }] },
        })
      }) as typeof fetch

      const resultPromise = client.getWalletBalance()
      for (let i = 0; i < 10 && call < 2; i++) {
        await vi.advanceTimersByTimeAsync(200)
      }
      const result = await resultPromise
      expect(result.totalEquity).toBe('999.5')
      expect(call).toBe(2)
    } finally {
      global.fetch = originalFetch
      vi.useRealTimers()
    }
  })
})
