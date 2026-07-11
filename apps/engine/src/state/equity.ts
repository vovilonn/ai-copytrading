// Реальный equity аккаунта для риск-сайзинга (Ф3, задача 4; research bybit-execution.md §14,
// design spec §8: "Риск% × equity_субаккаунта"). До этой задачи pipeline.ts получал equity
// хардкодом '1000' (see PipelineDeps.equity, комментарий там же) — здесь живой источник:
// `GET /v5/account/wallet-balance` (rest-client.ts::getWalletBalance). ПРОВОД в pipeline.ts —
// минимальный и сознательно НЕ сделан в этой задаче: pipeline.ts уже принимает `equity: string`
// в PipelineDeps, этого достаточно, чтобы main.ts (задача 5) решал "живой getEquity(rest) или
// дефолт-константа" и передавал готовую строку — сигнатура PipelineDeps не меняется вовсе.
//
// Кэш с TTL: wallet-balance — приватный GET (research §10, лимит 50/с/UID на клиента), но
// сайзинг может вызываться на каждый entry_signal внутри одного тика processChannel (main.ts) —
// без кэша каждое сообщение било бы биржу отдельным запросом без выигрыша в точности (equity не
// успевает измениться за доли секунды между двумя сообщениями одного тика). `forceRefresh`
// игнорирует кэш целиком — для мест, которым нужен заведомо свежий баланс (напр. диагностика).

import { Decimal } from 'decimal.js'
import type { BybitRestClient } from '../bybit/rest-client.js'

/** Узкий срез BybitRestClient — тот же приём сужения типа мока, что и BybitAdapterRestClient
 *  (execution/bybit.adapter.ts) и BybitPrivateWsRestClient (bybit/private-ws.ts). */
export type EquityRestClient = Pick<BybitRestClient, 'getWalletBalance'>

export interface GetEquityOptions {
  /** Принудительный рефреш — игнорирует кэш (и не читает, и не обновляет его состояние гонки
   *  с параллельным некэшированным вызовом), всегда бьёт wallet-balance. */
  forceRefresh?: boolean
  /**
   * Резерв под суб-аккаунты (design plan: провижининг суб-аккаунтов на канал — Ф-later; в Ф3
   * всегда один аккаунт, см. бриф задачи). `rest-client.ts::getWalletBalance` сейчас НЕ принимает
   * subaccount вовсе (один API-ключ = один аккаунт) — параметр здесь участвует ТОЛЬКО в ключе
   * кэша, чтобы будущее расширение (несколько суб-аккаунтов/ключей на канал) не потребовало
   * менять сигнатуру getEquity ни у одного из вызывающих мест уже сегодня.
   */
  subaccount?: string
}

const DEFAULT_TTL_MS = 30_000
const DEFAULT_SUBACCOUNT_KEY = 'default'

interface CacheEntry {
  value: Decimal
  fetchedAtMs: number
}

// Кэш СКОПИРОВАН на конкретный rest-клиент (WeakMap<rest, ...>), а не глобальный
// module-level singleton: в проде один процесс engine держит один BybitRestClient на всё время
// жизни — семантика та же, что и у простого singleton-кэша, но в тестах каждый `it()` создаёт
// свой мок `rest` — WeakMap гарантирует, что TTL одного теста не просочится в следующий без
// ручного сброса состояния между тестами.
const cacheByClient = new WeakMap<EquityRestClient, Map<string, CacheEntry>>()
// Дедупликация одновременных промахов кэша (напр. несколько entry_signal одного тика,
// решивших рефрешнуть баланс одновременно) — вторая параллельная некэшированная попытка
// дожидается ПЕРВОГО in-flight запроса вместо второго похода на биржу.
const inflightByClient = new WeakMap<EquityRestClient, Map<string, Promise<Decimal>>>()

function mapFor<V>(store: WeakMap<EquityRestClient, Map<string, V>>, rest: EquityRestClient): Map<string, V> {
  let m = store.get(rest)
  if (!m) {
    m = new Map()
    store.set(rest, m)
  }
  return m
}

/**
 * Реальный equity аккаунта — Decimal, из `totalEquity` wallet-balance (не `totalAvailableBalance`):
 * design spec §8 считает риск как "riskPct/100 × equity" от полного equity аккаунта (активы +
 * нереализованный PnL), а НЕ от `totalAvailableBalance` (это остаток СВОБОДНОЙ маржи — другая
 * величина, годная для проверки "хватит ли margin на новый вход", но не для формулы риск-сайзинга).
 *
 * Кэш TTL=30с на пару (rest-клиент, subaccount) — см. комментарии выше. `opts.forceRefresh`
 * всегда бьёт wallet-balance и обновляет кэш свежим значением.
 */
export async function getEquity(rest: EquityRestClient, opts: GetEquityOptions = {}): Promise<Decimal> {
  const key = opts.subaccount ?? DEFAULT_SUBACCOUNT_KEY
  const perClientCache = mapFor(cacheByClient, rest)

  if (!opts.forceRefresh) {
    const cached = perClientCache.get(key)
    if (cached && Date.now() - cached.fetchedAtMs < DEFAULT_TTL_MS) {
      return cached.value
    }

    const perClientInflight = mapFor(inflightByClient, rest)
    const existing = perClientInflight.get(key)
    if (existing) return existing
  }

  const perClientInflight = mapFor(inflightByClient, rest)
  const fetchPromise = (async (): Promise<Decimal> => {
    try {
      const balance = await rest.getWalletBalance()
      const value = new Decimal(balance.totalEquity)
      perClientCache.set(key, { value, fetchedAtMs: Date.now() })
      return value
    } finally {
      perClientInflight.delete(key)
    }
  })()

  if (!opts.forceRefresh) perClientInflight.set(key, fetchPromise)
  return fetchPromise
}
