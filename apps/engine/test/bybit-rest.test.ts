import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { BybitApiError, BybitRestClient, MAX_PAGINATION_PAGES, resolveAvailableBalance, TokenBucket, signPayload } from '../src/bybit/rest-client.js'
import { ServerClock } from '../src/bybit/server-time.js'

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

  // Фикс p3-slippage-fix (Important, найден e2e): живая проверка — публичный тикер отдаёт
  // непустые markPrice/lastPrice ДАЖЕ на аккаунте без истории позиций по символу (в отличие от
  // стаб-позиции getPositions, см. LOOP_STATE.md находка предыдущего лупа) — источник цены для
  // гейта slippage/staleness I2 (main.ts::createMarkPriceGetter). НЕ ставит ордеров — read-only.
  it('getTicker(SOLUSDT)/getTicker(BTCUSDT) → непустые markPrice/lastPrice (публичный, ключ не нужен для этого запроса)', async () => {
    const sol = await client.getTicker('SOLUSDT')
    console.log('[live] getTicker(SOLUSDT) =', JSON.stringify(sol))
    expect(sol.symbol).toBe('SOLUSDT')
    expect(sol.markPrice).not.toBe('')
    expect(Number(sol.markPrice)).toBeGreaterThan(0)
    expect(sol.lastPrice).not.toBe('')
    expect(Number(sol.lastPrice)).toBeGreaterThan(0)

    const btc = await client.getTicker('BTCUSDT')
    console.log('[live] getTicker(BTCUSDT) =', JSON.stringify(btc))
    expect(btc.symbol).toBe('BTCUSDT')
    expect(btc.markPrice).not.toBe('')
    expect(Number(btc.markPrice)).toBeGreaterThan(0)
    expect(btc.lastPrice).not.toBe('')
    expect(Number(btc.lastPrice)).toBeGreaterThan(0)
  })

  it('getTicker работает БЕЗ валидных ключей (публичный эндпоинт, подтверждает, что подпись не требуется)', async () => {
    // Отдельный клиент с заведомо мусорными ключами — если бы getTicker подписывал запрос своим
    // (неверным) ключом, Bybit отверг бы его ошибкой аутентификации. Успех здесь доказывает, что
    // publicGet() действительно не отправляет X-BAPI-* заголовки на этот эндпоинт.
    const anonClient = new BybitRestClient({ apiKey: 'not-a-real-key', apiSecret: 'not-a-real-secret', network: 'testnet' })
    const ticker = await anonClient.getTicker('SOLUSDT')
    console.log('[live] getTicker(SOLUSDT) без валидных ключей =', JSON.stringify(ticker))
    expect(Number(ticker.markPrice)).toBeGreaterThan(0)
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

  it('createOrder: stopLoss/slTriggerBy пробрасываются в тело запроса (Critical C1 — атомарный SL со входом)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let capturedBody: Record<string, unknown> | undefined
    await withMockFetch(
      (async (_url: unknown, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { orderId: 'abc-1', orderLinkId: 'K01-1-00-E0' } })
      }) as typeof fetch,
      () =>
        client.createOrder({
          symbol: 'BTCUSDT',
          side: 'Buy',
          orderType: 'Market',
          qty: '0.001',
          orderLinkId: 'K01-1-00-E0',
          stopLoss: '45000',
          slTriggerBy: 'LastPrice',
        }),
    )
    expect(capturedBody).toMatchObject({ stopLoss: '45000', slTriggerBy: 'LastPrice' })
  })

  it('createOrder: без stopLoss -> поле вообще не попадает в тело запроса (add/доливка не шлёт SL)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let capturedBody: Record<string, unknown> | undefined
    await withMockFetch(
      (async (_url: unknown, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { orderId: 'abc-2', orderLinkId: 'K01-1-00-A0' } })
      }) as typeof fetch,
      () => client.createOrder({ symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.001', orderLinkId: 'K01-1-00-A0' }),
    )
    expect(capturedBody).not.toHaveProperty('stopLoss')
    expect(capturedBody).not.toHaveProperty('slTriggerBy')
  })

  it('cancelOrder: retCode 110001 ("order not exists") → {ok:true, idempotent:true}, не бросает (Important I1)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const result = await withMockFetch(
      (async () => mockResponse({ retCode: 110001, retMsg: 'order not exists', result: {} })) as typeof fetch,
      () => client.cancelOrder({ symbol: 'BTCUSDT', orderLinkId: 'K01-1-00-S0' }),
    )
    expect(result).toEqual({ ok: true, idempotent: true })
  })

  it('cancelOrder: прочий ненулевой retCode бросает BybitApiError, не проглатывается', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    await expect(
      withMockFetch(
        (async () => mockResponse({ retCode: 10001, retMsg: 'params error', result: {} })) as typeof fetch,
        () => client.cancelOrder({ symbol: 'BTCUSDT', orderLinkId: 'K01-1-00-E0' }),
      ),
    ).rejects.toMatchObject({ retCode: 10001 })
  })

  it('getTicker: publicGet НЕ добавляет X-BAPI-* заголовки (публичный эндпоинт, без подписи/ключа)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let capturedHeaders: Record<string, string> | undefined
    let capturedUrl: string | undefined
    const ticker = await withMockFetch(
      (async (url: unknown, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedHeaders = { ...(init?.headers as Record<string, string>) }
        return mockResponse({
          retCode: 0,
          retMsg: 'OK',
          result: { category: 'linear', list: [{ symbol: 'SOLUSDT', lastPrice: '150.5', markPrice: '150.6' }] },
        })
      }) as typeof fetch,
      () => client.getTicker('SOLUSDT'),
    )
    expect(ticker).toEqual({ symbol: 'SOLUSDT', lastPrice: '150.5', markPrice: '150.6' })
    expect(capturedUrl).toContain('/v5/market/tickers?category=linear&symbol=SOLUSDT')
    expect(capturedHeaders).not.toHaveProperty('X-BAPI-API-KEY')
    expect(capturedHeaders).not.toHaveProperty('X-BAPI-SIGN')
    expect(capturedHeaders).not.toHaveProperty('X-BAPI-TIMESTAMP')
  })

  it('getTicker: пустой list (символ не найден) → бросает явную ошибку, не тихий undefined', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    await expect(
      withMockFetch(
        (async () => mockResponse({ retCode: 0, retMsg: 'OK', result: { category: 'linear', list: [] } })) as typeof fetch,
        () => client.getTicker('NOSUCHUSDT'),
      ),
    ).rejects.toThrow(/пустой list/)
  })

  it('getPositions: прокручивает nextPageCursor и собирает ОБЕ страницы (F1: limit=200, cursor 2-й страницы)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const urls: string[] = []
    let call = 0
    const positions = await withMockFetch(
      (async (url: unknown) => {
        urls.push(String(url))
        call++
        if (call === 1) {
          return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'AAAUSDT' }], nextPageCursor: 'CURSOR_2' } })
        }
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'BBBUSDT' }], nextPageCursor: '' } })
      }) as typeof fetch,
      () => client.getPositions(),
    )

    expect(positions.map((p) => p.symbol)).toEqual(['AAAUSDT', 'BBBUSDT'])
    expect(call).toBe(2)
    expect(urls[0]).toContain('limit=200')
    expect(urls[0]).not.toContain('cursor=') // первая страница — без курсора
    expect(urls[1]).toContain('cursor=CURSOR_2') // вторая — прокручен nextPageCursor
  })

  it('getPositions: пустой nextPageCursor -> ровно один запрос (одна страница, F1)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let call = 0
    const positions = await withMockFetch(
      (async () => {
        call++
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'AAAUSDT' }], nextPageCursor: '' } })
      }) as typeof fetch,
      () => client.getPositions(),
    )
    expect(positions.map((p) => p.symbol)).toEqual(['AAAUSDT'])
    expect(call).toBe(1)
  })

  it('getPositions: защита от бесконечного цикла — вечно меняющийся курсор ограничен MAX_PAGINATION_PAGES (F1)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let call = 0
    const positions = await withMockFetch(
      // Каждый ответ несёт НОВЫЙ (никогда не пустой) курсор — единственный стоп остаётся счётчик страниц.
      (async () => {
        call++
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: `S${call}USDT` }], nextPageCursor: `CURSOR_${call}` } })
      }) as typeof fetch,
      () => client.getPositions(),
    )
    expect(call).toBe(MAX_PAGINATION_PAGES)
    expect(positions).toHaveLength(MAX_PAGINATION_PAGES)
  })

  it('getOpenOrders: прокручивает nextPageCursor и собирает ОБЕ страницы (F1: limit=50)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const urls: string[] = []
    let call = 0
    const orders = await withMockFetch(
      (async (url: unknown) => {
        urls.push(String(url))
        call++
        if (call === 1) {
          return mockResponse({
            retCode: 0,
            retMsg: 'OK',
            result: { list: [{ symbol: 'AAAUSDT', orderLinkId: 'K-1' }], nextPageCursor: 'PAGE2' },
          })
        }
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'BBBUSDT', orderLinkId: 'K-2' }], nextPageCursor: '' } })
      }) as typeof fetch,
      () => client.getOpenOrders(),
    )
    expect(orders.map((o) => o.orderLinkId)).toEqual(['K-1', 'K-2'])
    expect(call).toBe(2)
    expect(urls[0]).toContain('limit=50')
    expect(urls[1]).toContain('cursor=PAGE2')
  })

  // РЕГРЕССИЯ (полная реконсиляция): getExecutions читал только ПЕРВУЮ страницу и молча ронял
  // остальные филлы (nextPageCursor игнорировался). При догоне за сутки простоя это тихая потеря
  // части истории → неверный PnL/позиции. Мок отдаёт курсор на 1-й странице — обязаны прийти ОБА филла.
  it('getExecutions: прокручивает nextPageCursor и собирает ОБЕ страницы (limit=100, category=linear)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const urls: string[] = []
    let call = 0
    const executions = await withMockFetch(
      (async (url: unknown) => {
        urls.push(String(url))
        call++
        if (call === 1) {
          return mockResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                { execId: 'E-1', symbol: 'BTCUSDT', execFee: '0.0043109', execValue: '10', execType: 'Trade', seq: 1 },
              ],
              nextPageCursor: 'EXEC_PAGE2',
            },
          })
        }
        return mockResponse({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [{ execId: 'E-2', symbol: 'BTCUSDT', execFee: '0.00429715', execValue: '10', execType: 'Trade', seq: 2 }],
            nextPageCursor: '',
          },
        })
      }) as typeof fetch,
      () => client.getExecutions({ symbol: 'BTCUSDT', startTime: 1_700_000_000_000, endTime: 1_700_086_400_000 }),
    )

    expect(executions.map((e) => e.execId)).toEqual(['E-1', 'E-2'])
    expect(call).toBe(2)
    expect(urls[0]).toContain('/v5/execution/list?')
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).toContain('symbol=BTCUSDT')
    expect(urls[0]).toContain('startTime=1700000000000')
    expect(urls[0]).toContain('endTime=1700086400000')
    expect(urls[0]).toContain('limit=100')
    expect(urls[0]).not.toContain('cursor=') // первая страница — без курсора
    expect(urls[1]).toContain('cursor=EXEC_PAGE2') // вторая — прокручен nextPageCursor
    // Поля из живого ответа не теряются при парсинге (execFee/execValue/seq — нужны реконсиляции).
    expect(executions[0]).toMatchObject({ execFee: '0.0043109', execValue: '10', execType: 'Trade', seq: 1 })
  })

  it('getExecutions: execType пробрасывается в query (фильтр Trade против Funding/Settle)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    let capturedUrl: string | undefined
    await withMockFetch(
      (async (url: unknown) => {
        capturedUrl = String(url)
        return mockResponse({ retCode: 0, retMsg: 'OK', result: { list: [], nextPageCursor: '' } })
      }) as typeof fetch,
      () => client.getExecutions({ execType: 'Trade' }),
    )
    expect(capturedUrl).toContain('execType=Trade')
  })

  it('getOrderHistory: путь /v5/order/history, category=linear, пагинация и парсинг терминальных статусов', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const urls: string[] = []
    let call = 0
    const orders = await withMockFetch(
      (async (url: unknown) => {
        urls.push(String(url))
        call++
        if (call === 1) {
          return mockResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [{ orderId: 'O-1', orderLinkId: 'K01-1-00-E0', orderStatus: 'Filled', symbol: 'BTCUSDT' }],
              nextPageCursor: 'HIST_PAGE2',
            },
          })
        }
        return mockResponse({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [
              {
                orderId: 'O-2',
                orderLinkId: '', // сработавший trading-stop SL: свой orderLinkId ПУСТ...
                parentOrderLinkId: 'K01-1-00-E0', // ...а мост к нашей сделке — parentOrderLinkId
                createType: 'CreateByStopLoss',
                orderStatus: 'Filled',
                symbol: 'BTCUSDT',
              },
            ],
            nextPageCursor: '',
          },
        })
      }) as typeof fetch,
      () => client.getOrderHistory({ symbol: 'BTCUSDT', startTime: 1_700_000_000_000 }),
    )

    expect(orders.map((o) => o.orderId)).toEqual(['O-1', 'O-2'])
    expect(orders.map((o) => o.orderStatus)).toEqual(['Filled', 'Filled'])
    expect(call).toBe(2)
    expect(urls[0]).toContain('/v5/order/history?')
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).toContain('symbol=BTCUSDT')
    expect(urls[0]).toContain('startTime=1700000000000')
    expect(urls[0]).toContain('limit=100')
    expect(urls[1]).toContain('cursor=HIST_PAGE2')
    expect(orders[1]).toMatchObject({ orderLinkId: '', parentOrderLinkId: 'K01-1-00-E0', createType: 'CreateByStopLoss' })
  })

  it('getClosedPnl: путь /v5/position/closed-pnl, category=linear, пагинация и парсинг closedPnl (НЕТТО)', async () => {
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet' })
    const urls: string[] = []
    let call = 0
    const rows = await withMockFetch(
      (async (url: unknown) => {
        urls.push(String(url))
        call++
        if (call === 1) {
          return mockResponse({
            retCode: 0,
            retMsg: 'OK',
            result: {
              // Живой ответ demo: closedPnl уже НЕТТО — gross(-0.025) - openFee - closeFee.
              list: [
                {
                  symbol: 'BTCUSDT',
                  orderId: 'O-1',
                  closedPnl: '-0.03360805',
                  openFee: '0.0043109',
                  closeFee: '0.00429715',
                  closedSize: '0.001',
                  avgEntryPrice: '100000',
                  avgExitPrice: '99975',
                },
              ],
              nextPageCursor: 'PNL_PAGE2',
            },
          })
        }
        return mockResponse({
          retCode: 0,
          retMsg: 'OK',
          result: {
            list: [{ symbol: 'SOLUSDT', orderId: 'O-2', closedPnl: '1.5', openFee: '0.01', closeFee: '0.01' }],
            nextPageCursor: '',
          },
        })
      }) as typeof fetch,
      () => client.getClosedPnl({ startTime: 1_700_000_000_000, endTime: 1_700_086_400_000 }),
    )

    expect(rows.map((r) => r.orderId)).toEqual(['O-1', 'O-2'])
    expect(call).toBe(2)
    expect(urls[0]).toContain('/v5/position/closed-pnl?')
    expect(urls[0]).toContain('category=linear')
    expect(urls[0]).toContain('startTime=1700000000000')
    expect(urls[0]).toContain('endTime=1700086400000')
    expect(urls[0]).toContain('limit=100')
    expect(urls[1]).toContain('cursor=PNL_PAGE2')

    // Фиксируем НЕТТО-семантику фактом: closedPnl == gross - openFee - closeFee (живая арифметика demo).
    const row = rows[0]!
    const gross = -0.025
    expect(Number(row.closedPnl)).toBeCloseTo(gross - Number(row.openFee) - Number(row.closeFee), 8)
  })

  it('retCode 10002 (часы разошлись) → пересинхронизирует часы биржи и повторяет запрос', async () => {
    // Живой инцидент e2e: после сна ноутбука VM Docker ушла на ~5 секунд, и Bybit начал отвергать
    // КАЖДЫЙ подписанный запрос — движок молча перестал писать снапшоты баланса. Теперь такой
    // ответ форсирует синхронизацию часов (bybit/server-time.ts) и повтор, а не пробрасывается наружу.
    let syncs = 0
    const clock = new ServerClock(async () => {
      syncs += 1
      return Date.now() + 5_000 // сервер на 5 секунд впереди наших часов
    })
    const client = new BybitRestClient({ apiKey: 'k', apiSecret: 's', network: 'testnet', clock })

    const timestamps: string[] = []
    let call = 0
    global.fetch = (async (_url: string, init?: RequestInit) => {
      call++
      timestamps.push(String((init?.headers as Record<string, string>)['X-BAPI-TIMESTAMP']))
      if (call === 1) {
        return mockResponse({
          retCode: 10002,
          retMsg: 'invalid request, please check your server timestamp or recv_window param',
          result: {},
        })
      }
      return mockResponse({
        retCode: 0,
        retMsg: 'OK',
        result: { list: [{ totalEquity: '42', totalAvailableBalance: '42', coin: [] }] },
      })
    }) as typeof fetch

    const result = await client.getWalletBalance()

    expect(result.totalEquity).toBe('42')
    expect(call).toBe(2)
    expect(syncs).toBe(1) // синхронизация случилась именно из-за 10002
    // Вторая подпись ушла уже по часам БИРЖИ — метка сдвинулась примерно на поправку.
    expect(Number(timestamps[1]) - Number(timestamps[0])).toBeGreaterThan(4_000)
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

// Живой ответ прода 31.07.2026: на UNIFIED-аккаунте с кросс-маржой Bybit отдаёт
// totalAvailableBalance ПУСТОЙ строкой (вместе со всеми верхнеуровневыми total*Margin), а реальные
// цифры кладёт в разрез монеты. Из-за пустого поля админка показывала «Available» равным полному
// депозиту, хотя $36 уже заняты маржой.
describe('resolveAvailableBalance — доступный остаток, когда биржа его не прислала', () => {
  const usdt = {
    coin: 'USDT',
    walletBalance: '278.71085633',
    usdValue: '283.05144717',
    availableToWithdraw: '',
    equity: '283.28345633',
    totalPositionIM: '36.63134143',
    totalOrderIM: '0',
  }

  it('биржа прислала значение -> берём его как есть, ничего не пересчитываем', () => {
    expect(resolveAvailableBalance('123.45', [usdt])).toBe('123.45')
  })

  it('пустая строка -> считаем сами: собственные средства минус занятая маржа', () => {
    // 283.28345633 − 36.63134143 − 0
    expect(resolveAvailableBalance('', [usdt])).toBe('246.6521149')
  })

  it('маржа под выставленными ордерами тоже вычитается', () => {
    expect(resolveAvailableBalance('', [{ ...usdt, totalOrderIM: '10' }])).toBe('236.6521149')
  })

  it('перегруз маржой -> ноль, а не отрицательный остаток', () => {
    expect(resolveAvailableBalance('', [{ ...usdt, totalPositionIM: '500' }])).toBe('0')
  })

  it('нет данных по монете -> пустая строка: врать числом нельзя, пусть решает вызывающий', () => {
    expect(resolveAvailableBalance('', [])).toBe('')
    expect(resolveAvailableBalance('', [{ ...usdt, equity: '' }])).toBe('')
  })

  it('settle-монета выбирается по USDT, а не по первой в списке', () => {
    const btc = { coin: 'BTC', walletBalance: '0.5', usdValue: '30000', availableToWithdraw: '', equity: '0.5', totalPositionIM: '0' }
    expect(resolveAvailableBalance('', [btc, usdt])).toBe('246.6521149')
  })
})
