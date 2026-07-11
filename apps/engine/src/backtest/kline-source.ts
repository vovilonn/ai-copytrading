import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * kline-оракул исторических цен Bybit для реплей-бэктеста (task-4-brief.md §3). READ-ONLY,
 * ПУБЛИЧНЫЙ `GET /v5/market/kline` — БЕЗ ключей/подписи (в отличие от bybit/rest-client.ts, где
 * живёт торговый REST с HMAC): историческая цена нужна и без аккаунта. Всегда MAINNET
 * (`https://api.bybit.com`) — только там реальная многолетняя история 1m-свечей; demo/testnet
 * истории не имеют, поэтому бэктест сверяется с ценами боевой биржи, а исполняет всё в dry-run.
 *
 * Формат ответа Bybit V5 kline (research bybit-execution.md): `result.list` — массив
 * `[startMs, open, high, low, close, volume, turnover]` (все строки), отсортирован по startMs
 * УБЫВАЮЩЕ (свежие первыми). Деньги/цены — строки, никогда number (CLAUDE.md).
 *
 * Кэш (в памяти + опционально на диске в scratchpad) — сотни сообщений на один прогон, повторно
 * дёргать API нельзя. Вежливый rate-limit (пауза `minIntervalMs` между реальными запросами) и
 * ретраи с экспоненциальным backoff — та же дисциплина, что и у торгового клиента.
 */

export interface Candle {
  /** startMs — время открытия свечи (мс). */
  start: number
  open: string
  high: string
  low: string
  close: string
}

/** Контракт, который потребляет replay.ts — реальный `KlineSource` ЛИБО мок в юнит-тесте. */
export interface KlineOracle {
  /** close-цена 1m-свечи, покрывающей момент `tMs` (округление вниз до минуты), или null. */
  klineAt(symbol: string, tMs: number): Promise<string | null>
  /** Восходящая по времени траектория свечей [startMs, endMs) на заданном интервале. */
  getCandles(symbol: string, startMs: number, endMs: number, interval?: KlineInterval): Promise<Candle[]>
  /** Диагностика прогона (сколько реальных HTTP-запросов сделано, размер кэша). */
  readonly stats: { requests: number; cacheHits: number; cachedKeys: number }
}

export type KlineInterval = '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | 'D'

const INTERVAL_MS: Record<KlineInterval, number> = {
  '1': 60_000,
  '3': 180_000,
  '5': 300_000,
  '15': 900_000,
  '30': 1_800_000,
  '60': 3_600_000,
  '120': 7_200_000,
  '240': 14_400_000,
  D: 86_400_000,
}

const MAINNET_HOST = 'https://api.bybit.com'
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 400
const MAX_BACKOFF_MS = 6_000
const DEFAULT_MIN_INTERVAL_MS = 120
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_PER_REQUEST = 1000
// Защитный потолок пагинации одной траектории — не уходим в бесконечный цикл на кривом окне.
const MAX_TRAJECTORY_REQUESTS = 8
const RATE_LIMIT_RETCODES = new Set([10006, 10018])

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface KlineSourceOptions {
  host?: string
  /** Инжектируемый fetch — юнит-тест подменяет его моком (без реальной сети). */
  fetchFn?: FetchFn
  sleepFn?: (ms: number) => Promise<void>
  /** Пауза между РЕАЛЬНЫМИ запросами, мс (вежливый rate-limit). */
  minIntervalMs?: number
  timeoutMs?: number
  /** Путь к JSON-файлу дискового кэша (scratchpad). Не задан — кэш только в памяти. */
  cacheFile?: string
}

interface KlineEnvelope {
  retCode: number
  retMsg: string
  result: { list?: unknown[] } | null
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}

/** Строка list -> Candle. Возвращает null, если формат неожиданный (не роняем весь прогон). */
function toCandle(row: unknown): Candle | null {
  if (!Array.isArray(row)) return null
  const [start, open, high, low, close] = row as unknown[]
  if (start === undefined || open === undefined || high === undefined || low === undefined || close === undefined) return null
  const startMs = Number(start)
  if (!Number.isFinite(startMs)) return null
  return { start: startMs, open: String(open), high: String(high), low: String(low), close: String(close) }
}

export class KlineSource implements KlineOracle {
  private readonly host: string
  private readonly fetchFn: FetchFn
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly cacheFile: string | undefined
  // Кэш свечных ОКОН: ключ `${interval}:${symbol}:${start}:${end}` -> список свечей (может быть []).
  private readonly windowCache = new Map<string, Candle[]>()
  // Кэш точечной 1m-цены: ключ `${symbol}:${minute}` -> close | null (null тоже кэшируется).
  private readonly pointCache = new Map<string, string | null>()
  private lastRequestAt = 0
  private _requests = 0
  private _cacheHits = 0

  constructor(opts: KlineSourceOptions = {}) {
    this.host = opts.host ?? MAINNET_HOST
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn)
    this.sleepFn = opts.sleepFn ?? defaultSleep
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheFile = opts.cacheFile
    this.loadDiskCache()
  }

  get stats(): { requests: number; cacheHits: number; cachedKeys: number } {
    return { requests: this._requests, cacheHits: this._cacheHits, cachedKeys: this.windowCache.size + this.pointCache.size }
  }

  async klineAt(symbol: string, tMs: number): Promise<string | null> {
    const minute = Math.floor(tMs / 60_000) * 60_000
    const key = `${symbol}:${minute}`
    const cached = this.pointCache.get(key)
    if (cached !== undefined || this.pointCache.has(key)) {
      this._cacheHits++
      return cached ?? null
    }

    // Окно [minute, minute+60000) — ровно одна 1m-свеча (Bybit может вернуть и соседнюю, берём нужную).
    const list = await this.fetchWindow(symbol, '1', minute, minute + 60_000)
    const exact = list.find((c) => c.start === minute)
    // Фолбэк: если точной минуты нет, берём самую позднюю свечу со start <= minute (покрывает tMs).
    const covering = exact ?? list.filter((c) => c.start <= minute).sort((a, b) => b.start - a.start)[0]
    const close = covering ? covering.close : null
    this.pointCache.set(key, close)
    this.saveDiskCache()
    return close
  }

  async getCandles(symbol: string, startMs: number, endMs: number, interval: KlineInterval = '15'): Promise<Candle[]> {
    if (endMs <= startMs) return []
    const intervalMs = INTERVAL_MS[interval]
    const window = intervalMs * MAX_PER_REQUEST
    const byStart = new Map<number, Candle>()
    let cursor = Math.floor(startMs / intervalMs) * intervalMs
    let requests = 0
    while (cursor < endMs && requests < MAX_TRAJECTORY_REQUESTS) {
      const winEnd = Math.min(cursor + window, endMs)
      const list = await this.fetchWindow(symbol, interval, cursor, winEnd)
      requests++
      for (const c of list) if (c.start >= startMs && c.start < endMs) byStart.set(c.start, c)
      if (list.length === 0) break
      cursor = winEnd
    }
    this.saveDiskCache()
    return [...byStart.values()].sort((a, b) => a.start - b.start)
  }

  /** Одно свечное окно с кэшем/ретраями/rate-limit. */
  private async fetchWindow(symbol: string, interval: KlineInterval, start: number, end: number): Promise<Candle[]> {
    const key = `${interval}:${symbol}:${start}:${end}`
    const cached = this.windowCache.get(key)
    if (cached !== undefined) {
      this._cacheHits++
      return cached
    }
    const list = await this.fetchKline(symbol, interval, start, end)
    this.windowCache.set(key, list)
    return list
  }

  private async fetchKline(symbol: string, interval: KlineInterval, start: number, end: number): Promise<Candle[]> {
    const url =
      `${this.host}/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${interval}&start=${start}&end=${end}&limit=${MAX_PER_REQUEST}`

    let lastError: Error | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttle()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        this._requests++
        const res = await this.fetchFn(url, { signal: ctrl.signal })
        if (!res.ok) {
          lastError = new Error(`kline HTTP ${res.status} (${symbol})`)
          if (attempt === MAX_ATTEMPTS) break
          await this.sleepFn(backoffMs(attempt))
          continue
        }
        const body = (await res.json()) as KlineEnvelope
        if (body.retCode === 0) {
          const rawList = body.result?.list ?? []
          const candles: Candle[] = []
          for (const row of rawList) {
            const c = toCandle(row)
            if (c) candles.push(c)
          }
          return candles
        }
        if (RATE_LIMIT_RETCODES.has(body.retCode)) {
          lastError = new Error(`kline rate-limit retCode=${body.retCode} (${symbol})`)
          if (attempt === MAX_ATTEMPTS) break
          await this.sleepFn(backoffMs(attempt))
          continue
        }
        // Прочий ненулевой retCode (напр. невалидный/делистнутый символ) — данных нет, не ретраим.
        return []
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt === MAX_ATTEMPTS) break
        await this.sleepFn(backoffMs(attempt))
      } finally {
        clearTimeout(timer)
      }
    }
    // Исчерпали ретраи — трактуем как "цены нет" (null/[]), а не роняем весь бэктест из-за одной свечи.
    console.warn(`[backtest/kline] ${symbol} ${interval} [${start},${end}): ${lastError?.message ?? 'нет данных'}`)
    return []
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt
    if (elapsed < this.minIntervalMs) await this.sleepFn(this.minIntervalMs - elapsed)
    this.lastRequestAt = Date.now()
  }

  // ---- дисковый кэш (best-effort; ошибки чтения/записи не роняют прогон) ----

  private loadDiskCache(): void {
    if (!this.cacheFile || !existsSync(this.cacheFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as {
        windows?: Record<string, Candle[]>
        points?: Record<string, string | null>
      }
      for (const [k, v] of Object.entries(raw.windows ?? {})) this.windowCache.set(k, v)
      for (const [k, v] of Object.entries(raw.points ?? {})) this.pointCache.set(k, v)
    } catch (err) {
      console.warn(`[backtest/kline] не удалось прочитать кэш ${this.cacheFile}: ${(err as Error).message}`)
    }
  }

  private saveDiskCache(): void {
    if (!this.cacheFile) return
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const payload = {
        windows: Object.fromEntries(this.windowCache),
        points: Object.fromEntries(this.pointCache),
      }
      writeFileSync(this.cacheFile, JSON.stringify(payload))
    } catch (err) {
      console.warn(`[backtest/kline] не удалось записать кэш ${this.cacheFile}: ${(err as Error).message}`)
    }
  }
}
