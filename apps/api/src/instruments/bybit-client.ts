import type { Network } from 'shared/domain.js'

// Тонкий клиент к ПУБЛИЧНЫМ market-эндпоинтам Bybit V5 (instruments-info, risk-limit) — ключ не
// нужен (docs/superpowers/research/bybit-execution.md §7). Раздельные хосты по сети — testnet
// и mainnet держат независимые листинги/лимиты (§13 того же дока). 'demo' (p3-task6-demo) —
// Bybit DEMO TRADING, публичные market-эндпоинты на api-demo.bybit.com проверены вживую (retCode=0).
// Экспортирован (I2 финального ревью Ф3): instruments.e2e.test.ts бьёт пробой доступности сети
// в хост АКТИВНОЙ сети (а не хардкод testnet) — тот же приём DRY, что и engine/bybit/rest-client.ts
// (там HOSTS экспортирован для live-e2e.test.ts).
export const HOSTS: Record<Network, string> = {
  testnet: 'https://api-testnet.bybit.com',
  mainnet: 'https://api.bybit.com',
  demo: 'https://api-demo.bybit.com',
}

interface BybitEnvelope<T> {
  retCode: number
  retMsg: string
  result: T
}

async function bybitGet<T>(url: URL): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status} на ${url.pathname}${url.search}`)
  const body = (await res.json()) as BybitEnvelope<T>
  if (body.retCode !== 0) {
    throw new Error(`Bybit retCode=${body.retCode} (${body.retMsg}) на ${url.pathname}${url.search}`)
  }
  return body.result
}

export interface InstrumentInfoDto {
  symbol: string
  status: string
  baseCoin: string
  // Валюта расчёта контракта ('USDT'/'USDC') и тип контракта ('LinearPerpetual'/'LinearFutures')
  // — нужны InstrumentsService.refresh() для фильтрации: система резолвит только USDT-перпетуалы
  // (symbol-resolver.ts всегда достраивает символ суффиксом USDT), остальное — балласт кэша.
  // contractType опционален defensively — вдруг Bybit его не отдаст (см. "если поле есть" в брифе).
  settleCoin: string
  contractType?: string
  lotSizeFilter: { qtyStep: string; minOrderQty: string; minNotionalValue?: string }
  priceFilter: { tickSize: string }
  leverageFilter: { maxLeverage: string; leverageStep: string }
}

// Полный набор статусов инструмента, которые отдаёт Bybit (поле `status`). ВАЖНО: bulk-запрос
// БЕЗ явного `status` возвращает ТОЛЬКО инструменты со status='Trading' (проверено вживую на
// testnet и mainnet — во всех строках status=Trading). Делистнутые/закрытые (например,
// GRASSUSDT, EIGENUSDT на testnet — status='Closed', см. §13 research-дока) в такую bulk-выдачу
// не попадают вовсе, хотя доступны по прямому запросу конкретного символа. Чтобы гейт
// status='Trading' мог отличить "неизвестный символ" от "известного, но сейчас не торгуется",
// перебираем весь известный набор статусов явными запросами. Валидные значения проверены
// вживую (несуществующий статус → retCode=10001 "status invalid"): 'Trading'/'PreLaunch'/
// 'Delivering' — задокументированы (https://bybit-exchange.github.io/docs/v5/market/instrument,
// категория linear); 'Settling' там НЕ валиден (в отличие от инверсных контрактов в некоторых
// версиях API); 'Closed' в доке не упомянут, но принимается живьём и возвращает делистнутые
// инструменты (см. комментарий выше про GRASSUSDT/EIGENUSDT).
const INSTRUMENT_STATUSES = ['Trading', 'PreLaunch', 'Delivering', 'Closed'] as const

const PAGE_LIMIT = 1000
const MAX_PAGES_PER_STATUS = 50 // защитная пагинация — на практике хватает 1-2 страниц на статус

/** Тянет весь реестр linear-инструментов (все статусы) активной сети, постранично по `nextPageCursor`. */
export async function fetchAllInstruments(network: Network): Promise<InstrumentInfoDto[]> {
  const host = HOSTS[network]
  const all: InstrumentInfoDto[] = []
  for (const status of INSTRUMENT_STATUSES) {
    let cursor = ''
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
      const url = new URL(`${host}/v5/market/instruments-info`)
      url.searchParams.set('category', 'linear')
      url.searchParams.set('status', status)
      url.searchParams.set('limit', String(PAGE_LIMIT))
      if (cursor) url.searchParams.set('cursor', cursor)
      const result = await bybitGet<{ list: InstrumentInfoDto[]; nextPageCursor: string }>(url)
      all.push(...result.list)
      cursor = result.nextPageCursor
      if (!cursor) break
    }
  }
  return all
}

interface RiskLimitTierDto {
  maintenanceMargin: string
  isLowestRisk: number
}

/**
 * MMR (maintenance margin rate) tier1 (`isLowestRisk===1`) по одному символу активной сети.
 * Точечный запрос на символ, а не bulk-пагинация: полный bulk risk-limit (без `symbol`) на
 * testnet прогонялся вживую ~30с на 700+ символов (49 страниц) — впритык/за таймаут e2e-теста.
 * Точечные запросы с ограниченной конкурентностью (см. mapWithConcurrency) укладываются в ~10с
 * на те же 700+ символов (тоже проверено вживую).
 * Возвращает null, если у Bybit нет тиров для символа (делистнутый инструмент → retCode=10001)
 * или запрос не удался — единичный сетевой сбой не должен ронять весь refresh().
 */
export async function fetchTier1Mmr(network: Network, symbol: string): Promise<string | null> {
  const host = HOSTS[network]
  const url = new URL(`${host}/v5/market/risk-limit`)
  url.searchParams.set('category', 'linear')
  url.searchParams.set('symbol', symbol)
  try {
    const result = await bybitGet<{ list: RiskLimitTierDto[] }>(url)
    return result.list.find((tier) => tier.isLowestRisk === 1)?.maintenanceMargin ?? null
  } catch (err) {
    // retCode=10001 ("params error"/делистнутый символ без risk-limit) — ОЖИДАЕМЫЙ исход,
    // глотаем тихо. Всё остальное (сетевой сбой, HTTP-ошибка, иной retCode) — не должно тонуть
    // молча: MMR участвует в формуле безопасного плеча, поэтому такие сбои обязаны попасть в лог.
    const isExpectedDelisted = err instanceof Error && err.message.includes('retCode=10001')
    if (!isExpectedDelisted) {
      console.warn(`fetchTier1Mmr(${symbol}): непредвиденная ошибка risk-limit`, err)
    }
    return null
  }
}

/**
 * Ограничивает конкурентность промисов простым воркер-пулом — без внешней зависимости
 * (p-limit и т.п.), нужной ровно для одного места (fetchTier1Mmr по ~700 символам в refresh()).
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  concurrency: number,
  fn: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      if (item === undefined) continue
      results[i] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()))
  return results
}
