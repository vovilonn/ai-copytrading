// Bybit V5 REST-клиент (research bybit-execution.md § Global/§10; design plan
// docs/superpowers/plans/2026-07-11-phase-3-live-testnet.md, задача 1). Единственная точка,
// где живёт HMAC-подпись и токен-бакет rate-limiter Bybit — BybitAdapter (задача 2, Ф3)
// использует ТОЛЬКО этот клиент, сам не подписывает запросы и не ходит в fetch напрямую.
//
// Идемпотентность (research §2/§8): повторная установка ТОГО ЖЕ плеча → retCode 110043,
// дубль orderLinkId → retCode 110072 — оба трактуются НЕ как ошибка, а как идемпотентный успех
// (`{ ok: true, idempotent: true }`), не бросаются наверх. Прочие ненулевые retCode бросаются
// как BybitApiError(retCode, retMsg) — решение "это ошибка или скрытый успех" принимает
// вызывающий метод, не общий транспортный слой.

import { createHmac } from 'node:crypto'
import type { Network } from 'shared/domain.js'

const HOSTS: Record<Network, string> = {
  testnet: 'https://api-testnet.bybit.com',
  mainnet: 'https://api.bybit.com',
}

const RECV_WINDOW = '5000'
// AbortController-таймаут одного HTTP-вызова (задача: "~15с") — тот же приём, что и в
// ai/client.ts::callOnce (Important #1 адверсариального ревью Ф2): без таймаута зависший сокет
// держал бы вызывающий код (в т.ч. будущий BybitAdapter внутри db.transaction()) неопределённо
// долго на дефолтах undici.
const DEFAULT_TIMEOUT_MS = 15_000

// Ретраи (research §10): 10006 (UID rate limit)/10018 (IP rate limit) и сетевые сбои/не-2xx HTTP —
// ретраить с backoff (плюс ожидание до X-Bapi-Limit-Reset-Timestamp для rate-limit кодов).
// Прочие ненулевые retCode — НЕ ретраить, бросить немедленно.
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 300
const MAX_BACKOFF_MS = 4_000
// Защитный потолок ожидания до reset — если заголовок отсутствует/в прошлом/сильно разошёлся
// с локальными часами, не ждём неопределённо долго.
const MAX_RATE_LIMIT_WAIT_MS = 5_000

// Раздельные бакеты (research §10, живые заголовки): GET = 50/с на UID; мутации документированы
// ~10/с — берём с запасом ~5/с, чтобы не соревноваться с живым лимитом биржи.
const GET_BUCKET_CAPACITY = 50
const GET_BUCKET_REFILL_PER_SEC = 50
const MUTATE_BUCKET_CAPACITY = 5
const MUTATE_BUCKET_REFILL_PER_SEC = 5

const RATE_LIMIT_RETCODES = new Set([10006, 10018])
// "Set leverage has not been modified" (research §2) — идемпотентный успех setLeverage.
const LEVERAGE_NOT_MODIFIED_RETCODE = 110043
// "OrderLinkedID is duplicate" (research §8) — идемпотентный успех createOrder.
const DUPLICATE_ORDER_LINK_ID_RETCODE = 110072
// "Position mode is not modified" — трактуется как идемпотентный успех switchMode (симметрично
// 110043 для плеча). В отличие от 110043/110072, этот код НЕ подтверждён живым вызовом в рамках
// research bybit-execution.md (аккаунт уже one-way, повторный switch-mode — мутация, была вне
// мандата верификации, см. §1/§13 дока) — источник: публичная документация кодов ошибок Bybit
// V5 и практика ccxt/pybit-обёрток. Если код окажется иным, вызывающая сторона (BybitAdapter,
// задача 2) увидит явный throw BybitApiError вместо тихого проглатывания — не тихий баг.
const POSITION_MODE_NOT_MODIFIED_RETCODE = 110025
// "Order does not exist" (Important I1 адверсариального ревью p3-core-fix-report.md) — код из
// публичной документации Bybit V5 (список retCode ошибок), тем же статусом верификации, что и
// POSITION_MODE_NOT_MODIFIED_RETCODE выше: НЕ подтверждён живым мутирующим вызовом в рамках
// research (мандат верификации — read-only на пустом testnet-аккаунте), но это ДОКУМЕНТИРОВАННЫЙ
// код для "нет такого ордера" (уже исполнен/уже отменён/никогда не существовал на бирже —
// SL-строка orders хранится как trading-stop, у неё нет bybit_order_id, order/cancel по её
// orderLinkId закономерно вернул бы именно этот код). Трактуем как идемпотентный успех отмены —
// поздняя/повторная отмена уже пропавшего ордера не должна ронять cancelOrder и клинить свип/делту.
const ORDER_NOT_EXISTS_RETCODE = 110001

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

/** Ошибка Bybit с ненулевым retCode — несёт retCode/retMsg, чтобы вызывающая сторона могла решить,
 *  является ли конкретный код идемпотентным успехом (110043/110072/...), не она сама решает. */
export class BybitApiError extends Error {
  constructor(
    message: string,
    readonly retCode: number,
    readonly retMsg: string,
  ) {
    super(message)
    this.name = 'BybitApiError'
  }
}

/**
 * Токен-бакет (research §10): проактивно держит частоту запросов ниже лимита биржи, не дожидаясь
 * фактического retCode 10006/10018. `now` инжектируется параметром (а не жёстко Date.now внутри
 * refill()) — тест "рэйт-лимитер ограничивает частоту" гоняет `vi.useFakeTimers()`, а bucket сам
 * не имеет доступа к системному времени иначе, кроме как через этот аргумент.
 */
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.lastRefillMs = now()
  }

  private refill(): void {
    const nowMs = this.now()
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec)
      this.lastRefillMs = nowMs
    }
  }

  /** Блокируется (через `setTimeout`-сон), пока не появится свободный токен, затем расходует один. */
  async take(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const missing = 1 - this.tokens
      const waitMs = Math.max(Math.ceil((missing / this.refillPerSec) * 1000), 1)
      await sleep(waitMs)
    }
  }
}

export interface RateLimitInfo {
  limit: number | null
  status: number | null
  resetTimestamp: number | null
}

/** Парсит `X-Bapi-Limit`/`X-Bapi-Limit-Status`/`X-Bapi-Limit-Reset-Timestamp` (research §10). */
function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const limit = headers.get('x-bapi-limit')
  const status = headers.get('x-bapi-limit-status')
  const reset = headers.get('x-bapi-limit-reset-timestamp')
  return {
    limit: limit !== null ? Number(limit) : null,
    status: status !== null ? Number(status) : null,
    resetTimestamp: reset !== null ? Number(reset) : null,
  }
}

/**
 * HMAC-подпись Bybit V5 (research bybit-execution.md, § проверенные факты окружения):
 *   GET  → HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString)
 *   POST → HMAC_SHA256(secret, timestamp + apiKey + recvWindow + jsonBody)
 * Экспортирована как чистая функция — тест сверяет с эталоном, посчитанным вручную (без сети,
 * без класса клиента).
 */
export function signPayload(
  apiSecret: string,
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryStringOrBody: string,
): string {
  return createHmac('sha256', apiSecret).update(`${timestamp}${apiKey}${recvWindow}${queryStringOrBody}`).digest('hex')
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  return search.toString()
}

interface BybitEnvelope<T> {
  retCode: number
  retMsg: string
  result: T
}

export interface BybitRestClientOptions {
  apiKey: string
  apiSecret: string
  network: Network
  /** Таймаут одного HTTP-вызова, мс (research §10: "~15с"). Дефолт 15000. */
  timeoutMs?: number
  /** Переопределение хоста — только для тестов (мок-сервер), в продакшене не передаётся. */
  baseUrl?: string
}

type HttpMethod = 'GET' | 'POST'

export interface WalletCoinBalance {
  coin: string
  walletBalance: string
  usdValue: string
  availableToWithdraw: string
}

export interface WalletBalance {
  totalEquity: string
  totalAvailableBalance: string
  coins: WalletCoinBalance[]
}

/** `GET /v5/position/list` (research §1/§14) — поля, нужные сайзингу/реконсиляции/UI. */
export interface Position {
  symbol: string
  side: string // 'Buy' | 'Sell' | 'None' (плоская позиция-стаб при size=0, research §1)
  size: string
  avgPrice: string
  leverage: string
  positionIdx: number
  tradeMode: number
  liqPrice: string
  markPrice: string
  positionValue: string
  unrealisedPnl: string
  takeProfit: string
  stopLoss: string
  positionStatus: string
  createdTime: string
  updatedTime: string
  seq: number
}

/**
 * `GET /v5/market/tickers` (публичный, без ключа/подписи) — фикс p3-slippage-fix: источник живого
 * mark price для гейта slippage/staleness (Important I2), НЕ зависящий от истории позиций
 * аккаунта (в отличие от стаб-позиции `position/list`, см. LOOP_STATE.md находка предыдущего
 * лупа: `markPrice=""` на "холодном" символе). Bybit всегда отдаёт непустые `markPrice`/
 * `lastPrice` для любого торгуемого символа category=linear.
 */
export interface Ticker {
  symbol: string
  lastPrice: string
  markPrice: string
}

/** `GET /v5/order/realtime` (research §9/§14). */
export interface Order {
  orderId: string
  orderLinkId: string
  symbol: string
  side: string
  orderType: string
  price: string
  qty: string
  cumExecQty: string
  orderStatus: string
  timeInForce: string
  reduceOnly: boolean
  stopOrderType?: string
  createdTime: string
  updatedTime: string
}

/** `GET /v5/execution/list` (research §11: атрибуция филлов по orderLinkId/closedSize). */
export interface Execution {
  symbol: string
  orderId: string
  orderLinkId: string
  side: string
  execId: string
  execPrice: string
  execQty: string
  execType: string
  closedSize: string
  leavesQty: string
  execTime: string
  isMaker: boolean
}

export interface GetExecutionsParams {
  symbol?: string
  orderId?: string
  orderLinkId?: string
  startTime?: number
  endTime?: number
  limit?: number
}

export interface CreateOrderParams {
  symbol: string
  side: 'Buy' | 'Sell'
  orderType: 'Market' | 'Limit'
  qty: string
  /** Обязательна для Limit; для Market не передаётся. */
  price?: string
  orderLinkId: string
  reduceOnly?: boolean
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PostOnly'
  /** one-way (research §1) — дефолт 0, если не передано. */
  positionIdx?: 0 | 1 | 2
  /**
   * Critical C1 адверсариального ревью (p3-core-fix-report.md): Bybit V5 `order/create` принимает
   * `stopLoss`/`slTriggerBy` прямо в теле создания ордера — SL устанавливается на позицию
   * АТОМАРНО с её открытием (тот же сетевой вызов), а не отдельным `position/trading-stop` после.
   * Либо позиция открывается уже защищённой, либо не открывается вовсе (вход отклонён целиком).
   */
  stopLoss?: string
  slTriggerBy?: string
}

export interface SetTradingStopParams {
  symbol: string
  positionIdx?: 0 | 1 | 2
  /** 'Full' — весь остаток (SL), 'Partial' — частичный (лесенка TP), research §4/§5. */
  tpslMode?: 'Full' | 'Partial'
  stopLoss?: string
  takeProfit?: string
  slTriggerBy?: string
  tpTriggerBy?: string
  /** Обязана совпадать с tpSize при передаче ОБОИХ в одном вызове (research §4) — вызывающая
   *  сторона (BybitAdapter) не должна смешивать частичный TP и SL в одном setTradingStop. */
  tpSize?: string
  slSize?: string
  tpOrderType?: 'Market' | 'Limit'
  tpLimitPrice?: string
}

/**
 * Bybit V5 REST-клиент: HMAC-подпись, токен-бакет rate-limiter, идемпотентные коды 110043/110072.
 * Единственная сетевая точка входа к торговому REST Bybit — BybitAdapter (задача 2) вызывает
 * только методы этого класса.
 */
export class BybitRestClient {
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly host: string
  private readonly timeoutMs: number
  private readonly getBucket = new TokenBucket(GET_BUCKET_CAPACITY, GET_BUCKET_REFILL_PER_SEC)
  private readonly mutateBucket = new TokenBucket(MUTATE_BUCKET_CAPACITY, MUTATE_BUCKET_REFILL_PER_SEC)

  constructor(opts: BybitRestClientOptions) {
    this.apiKey = opts.apiKey
    this.apiSecret = opts.apiSecret
    this.host = opts.baseUrl ?? HOSTS[opts.network]
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async signedGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.execute<T>('GET', path, params, { signed: true })
  }

  private async signedPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.execute<T>('POST', path, body, { signed: true })
  }

  /**
   * GET без HMAC-подписи/ключа — публичные market-эндпоинты Bybit V5 (research: `/v5/market/*`
   * не требуют аутентификации). Используется getTicker (фикс p3-slippage-fix, LOOP_STATE.md
   * находка: стаб-позиция `position/list` при size=0 может отдавать пустой markPrice на
   * аккаунте без истории по символу — публичный тикер не зависит от истории аккаунта вовсе).
   */
  private async publicGet<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return this.execute<T>('GET', path, params, { signed: false })
  }

  /**
   * Один вызов Bybit с ретраями (research §10):
   *  - токен-бакет (GET/мутации раздельно) перед КАЖДОЙ попыткой, включая повторные;
   *  - 10006/10018 (rate limit) → ждать до `X-Bapi-Limit-Reset-Timestamp` (+backoff), ретрай;
   *  - сетевые сбои/таймаут/не-2xx HTTP → backoff-ретрай;
   *  - прочий ненулевой retCode (включая 110043/110072/110025) → бросить BybitApiError НЕМЕДЛЕННО,
   *    без ретрая — конкретный публичный метод (setLeverage/createOrder/switchMode) решает,
   *    идемпотентный ли это успех.
   *  - `opts.signed` (дефолт true) — публичные market-эндпоинты (getTicker) идут без HMAC-подписи
   *    и без ключа вовсе (заголовки X-BAPI-* не добавляются) — путь `signedGet`/`signedPost`
   *    не затронут, оба по-прежнему подписывают запрос.
   */
  private async execute<T>(
    method: HttpMethod,
    path: string,
    params: Record<string, unknown>,
    opts: { signed: boolean },
  ): Promise<T> {
    const bucket = method === 'GET' ? this.getBucket : this.mutateBucket
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await bucket.take()

      const isGet = method === 'GET'
      const queryString = isGet ? buildQueryString(params as Record<string, string | number | boolean | undefined>) : ''
      const jsonBody = isGet ? '' : JSON.stringify(params)
      const url = `${this.host}${path}${isGet && queryString ? `?${queryString}` : ''}`

      const headers: Record<string, string> = {}
      if (opts.signed) {
        const timestamp = String(Date.now())
        const signature = signPayload(this.apiSecret, timestamp, this.apiKey, RECV_WINDOW, isGet ? queryString : jsonBody)
        headers['X-BAPI-API-KEY'] = this.apiKey
        headers['X-BAPI-TIMESTAMP'] = timestamp
        headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW
        headers['X-BAPI-SIGN'] = signature
      }
      if (!isGet) headers['Content-Type'] = 'application/json'

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)

      try {
        let res: Response
        try {
          res = await fetch(url, { method, headers, body: isGet ? undefined : jsonBody, signal: ctrl.signal })
        } catch (err) {
          // Сетевой сбой ИЛИ таймаут (AbortError от ctrl.abort()) — ретраить backoff'ом, тот же
          // приём, что и в ai/client.ts::callOnce.
          lastError = new Error(`Bybit сеть (${path}): ${(err as Error).message}`)
          if (attempt === MAX_ATTEMPTS) throw lastError
          await sleep(backoffMs(attempt))
          continue
        }

        const rateLimitInfo = parseRateLimitHeaders(res.headers)

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          lastError = new Error(`Bybit HTTP ${res.status} на ${path}: ${text.slice(0, 300)}`)
          if (attempt === MAX_ATTEMPTS) throw lastError
          await sleep(backoffMs(attempt))
          continue
        }

        const body = (await res.json()) as BybitEnvelope<T>

        if (body.retCode === 0) {
          return body.result
        }

        if (RATE_LIMIT_RETCODES.has(body.retCode)) {
          // 10006 (UID) / 10018 (IP) — ждать до заявленного reset + небольшой backoff, ретрай
          // (research §10). Нет заголовка/reset уже в прошлом → просто backoff.
          lastError = new BybitApiError(`Bybit retCode=${body.retCode} (${body.retMsg}) на ${path}`, body.retCode, body.retMsg)
          if (attempt === MAX_ATTEMPTS) throw lastError
          const waitForReset =
            rateLimitInfo.resetTimestamp !== null
              ? Math.min(Math.max(rateLimitInfo.resetTimestamp - Date.now(), 0), MAX_RATE_LIMIT_WAIT_MS)
              : 0
          await sleep(waitForReset + backoffMs(attempt))
          continue
        }

        // Прочий ненулевой retCode — не ретраим здесь; решение "идемпотентный успех или ошибка"
        // принимает вызывающий публичный метод (setLeverage/createOrder/switchMode).
        throw new BybitApiError(`Bybit retCode=${body.retCode} (${body.retMsg}) на ${path}`, body.retCode, body.retMsg)
      } finally {
        clearTimeout(timer)
      }
    }

    // Недостижимо (цикл либо возвращает результат, либо кидает на последней попытке) —
    // для полноты типов TS (noImplicitReturns).
    throw lastError ?? new Error(`Bybit: исчерпаны попытки без результата (${path})`)
  }

  /** `GET /v5/account/wallet-balance accountType=UNIFIED` (research §14). */
  async getWalletBalance(): Promise<WalletBalance> {
    const result = await this.signedGet<{
      list: Array<{ totalEquity: string; totalAvailableBalance: string; coin: WalletCoinBalance[] }>
    }>('/v5/account/wallet-balance', { accountType: 'UNIFIED' })
    const account = result.list[0]
    if (!account) throw new Error('getWalletBalance: Bybit вернул пустой list для accountType=UNIFIED')
    return { totalEquity: account.totalEquity, totalAvailableBalance: account.totalAvailableBalance, coins: account.coin }
  }

  /** `GET /v5/position/list category=linear` — `settleCoin=USDT`, если `symbol` не задан (research §14). */
  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, string> = { category: 'linear' }
    if (symbol) params.symbol = symbol
    else params.settleCoin = 'USDT'
    const result = await this.signedGet<{ list: Position[] }>('/v5/position/list', params)
    return result.list
  }

  /** `GET /v5/order/realtime category=linear openOnly=0` — `settleCoin=USDT`, если `symbol` не задан (research §9). */
  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const params: Record<string, string | number> = { category: 'linear', openOnly: 0 }
    if (symbol) params.symbol = symbol
    else params.settleCoin = 'USDT'
    const result = await this.signedGet<{ list: Order[] }>('/v5/order/realtime', params)
    return result.list
  }

  /**
   * `GET /v5/market/tickers category=linear symbol=<S>` — публичный (без ключа/подписи), фикс
   * p3-slippage-fix. Источник mark price для гейта I2 вместо стаб-позиции `getPositions` (та
   * возвращает `markPrice=""` на аккаунте без истории по символу, см. Ticker выше). Бросает,
   * если Bybit вернул пустой `list` (символ не найден на бирже) — вызывающая сторона
   * (main.ts::createMarkPriceGetter) ловит это как сбой похода за ценой -> null -> гейт fail-closed.
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const result = await this.publicGet<{ list: Ticker[] }>('/v5/market/tickers', { category: 'linear', symbol })
    const ticker = result.list[0]
    if (!ticker) throw new Error(`getTicker(${symbol}): Bybit вернул пустой list`)
    return ticker
  }

  /** `GET /v5/execution/list category=linear` (research §11/§14: атрибуция филлов по orderLinkId). */
  async getExecutions(params: GetExecutionsParams = {}): Promise<Execution[]> {
    const query: Record<string, string | number> = { category: 'linear' }
    if (params.symbol) query.symbol = params.symbol
    if (params.orderId) query.orderId = params.orderId
    if (params.orderLinkId) query.orderLinkId = params.orderLinkId
    if (params.startTime !== undefined) query.startTime = params.startTime
    if (params.endTime !== undefined) query.endTime = params.endTime
    if (params.limit !== undefined) query.limit = params.limit
    const result = await this.signedGet<{ list: Execution[] }>('/v5/execution/list', query)
    return result.list
  }

  /**
   * `POST /v5/position/set-leverage` (research §2): `buyLeverage=sellLeverage` в one-way.
   * Повторная установка ТОГО ЖЕ плеча → retCode 110043 — идемпотентный успех, не бросаем.
   */
  async setLeverage(symbol: string, leverage: string): Promise<{ ok: true; idempotent: boolean }> {
    try {
      await this.signedPost('/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: leverage,
        sellLeverage: leverage,
      })
      return { ok: true, idempotent: false }
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === LEVERAGE_NOT_MODIFIED_RETCODE) {
        return { ok: true, idempotent: true }
      }
      throw err
    }
  }

  /** `POST /v5/position/switch-mode` (research §1): `mode=0` one-way / `mode=3` hedge. */
  async switchMode(symbol: string, mode: 0 | 3): Promise<{ ok: true }> {
    try {
      await this.signedPost('/v5/position/switch-mode', { category: 'linear', symbol, mode })
      return { ok: true }
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === POSITION_MODE_NOT_MODIFIED_RETCODE) {
        return { ok: true }
      }
      throw err
    }
  }

  /**
   * `POST /v5/order/create` (research §8): `orderLinkId` — ключ идемпотентности. Дубль →
   * retCode 110072 — идемпотентный успех. Bybit НЕ возвращает `orderId` в error-конверте
   * дубля, поэтому `orderId` в идемпотентном ответе пуст — вызывающая сторона (BybitAdapter)
   * уже хранит `orderId` из первой успешной попытки, это повтор/ретрай ТОГО ЖЕ вызова.
   */
  async createOrder(
    params: CreateOrderParams,
  ): Promise<{ orderId: string; orderLinkId: string; ok: true; idempotent: boolean }> {
    try {
      const result = await this.signedPost<{ orderId: string; orderLinkId: string }>('/v5/order/create', {
        category: 'linear',
        symbol: params.symbol,
        side: params.side,
        orderType: params.orderType,
        qty: params.qty,
        price: params.price,
        orderLinkId: params.orderLinkId,
        reduceOnly: params.reduceOnly,
        timeInForce: params.timeInForce,
        positionIdx: params.positionIdx ?? 0,
        // Critical C1: undefined -> JSON.stringify отбрасывает поле целиком (тот же приём, что и
        // price/reduceOnly/timeInForce выше) — вход БЕЗ atomic-SL (напр. add/доливка) не шлёт
        // stopLoss вовсе, ничего не меняя для Bybit относительно поведения до этого фикса.
        stopLoss: params.stopLoss,
        slTriggerBy: params.slTriggerBy,
      })
      return { orderId: result.orderId, orderLinkId: result.orderLinkId, ok: true, idempotent: false }
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === DUPLICATE_ORDER_LINK_ID_RETCODE) {
        return { orderId: '', orderLinkId: params.orderLinkId, ok: true, idempotent: true }
      }
      throw err
    }
  }

  /**
   * `POST /v5/order/cancel` (research §9) — по `orderLinkId`. Important I1 адверсариального
   * ревью: ордер, которого уже нет на бирже (исполнен раньше, чем дошла отмена; WS пропустил
   * филл; либо это в принципе не биржевой ордер — trading-stop SL, см. bybit.adapter.ts::
   * cancelOrder) отвечает `retCode=110001` — трактуем как идемпотентный успех отмены (та же
   * идея, что 110043/110072 у setLeverage/createOrder), а не бросаем и не клиним свип/делту.
   */
  async cancelOrder(params: { symbol: string; orderLinkId: string }): Promise<{ ok: true; idempotent?: boolean }> {
    try {
      await this.signedPost('/v5/order/cancel', {
        category: 'linear',
        symbol: params.symbol,
        orderLinkId: params.orderLinkId,
      })
      return { ok: true }
    } catch (err) {
      if (err instanceof BybitApiError && err.retCode === ORDER_NOT_EXISTS_RETCODE) {
        return { ok: true, idempotent: true }
      }
      throw err
    }
  }

  /** `POST /v5/order/cancel-all` (research §9) — все активные ордера символа. */
  async cancelAll(symbol: string): Promise<{ ok: true }> {
    await this.signedPost('/v5/order/cancel-all', { category: 'linear', symbol })
    return { ok: true }
  }

  /** `POST /v5/position/trading-stop` (research §4/§5) — SL (Full) / частичный TP (Partial). */
  async setTradingStop(params: SetTradingStopParams): Promise<{ ok: true }> {
    await this.signedPost('/v5/position/trading-stop', {
      category: 'linear',
      symbol: params.symbol,
      positionIdx: params.positionIdx ?? 0,
      tpslMode: params.tpslMode ?? 'Full',
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      slTriggerBy: params.slTriggerBy,
      tpTriggerBy: params.tpTriggerBy,
      tpSize: params.tpSize,
      slSize: params.slSize,
      tpOrderType: params.tpOrderType,
      tpLimitPrice: params.tpLimitPrice,
    })
    return { ok: true }
  }
}
