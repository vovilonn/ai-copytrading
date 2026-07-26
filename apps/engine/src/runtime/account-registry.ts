// Реестр торговых аккаунтов: какой канал каким аккаунтом Bybit торгует.
//
// ЗАЧЕМ. До этого движок держал ОДИН REST-клиент и ОДИН приватный WS на все каналы (main.ts), хотя
// схема с самого начала предусматривала «свой субаккаунт на канал» (channels.bybit_api_key_enc).
// На одном аккаунте два канала неизбежно мешают друг другу: позиции по общему символу неттингуются
// (режим one-way), пуш достаётся произвольному владельцу символа, а риск-сайзинг каждого канала
// считает депозит своим целиком.
//
// МОДЕЛЬ. Аккаунт — это НАБОР КРЕДОВ, а не канал. Канал ссылается на аккаунт своими ключами;
// каналы без ключей обслуживает общий аккаунт из BYBIT_API_KEY — то есть поведение до этой задачи
// сохраняется без миграций и без действий оператора.
//
// ДЕДУПЛИКАЦИЯ ПО КЛЮЧУ — не оптимизация, а корректность: два WS-соединения с одними и теми же
// кредами получают одни и те же пуши, и каждый филл обработался бы дважды. Поэтому каналы с
// одинаковым apiKey делят один рантайм. Побочно это даёт режим проверки без реальных субаккаунтов:
// прописать двум тестовым каналам одни demo-креды и убедиться, что маршрутизация по каналам работает.

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network } from 'shared/domain.js'
import { BybitRestClient } from '../bybit/rest-client.js'
import { BybitPrivateWs } from '../bybit/private-ws.js'
import { createExecutionPort, type ExecutionPort } from '../execution/port.js'
import { getChannelKeys, type ChannelKeys } from '../bybit/channel-keys.js'

/** Один торговый аккаунт и всё, что к нему привязано. */
export interface AccountRuntime {
  /**
   * Идентификатор аккаунта в логах и ключах курсоров. Короткий хеш apiKey, а не сам ключ:
   * fingerprint попадает в app_state и в логи, где секрету не место.
   */
  fingerprint: string
  /** Каналы, которые торгуют этим аккаунтом. */
  channelIds: number[]
  /** true — аккаунт из BYBIT_API_KEY (каналы без собственных ключей). */
  shared: boolean
  rest: BybitRestClient
  executionPort: ExecutionPort
  privateWs: BybitPrivateWs
  /** Обновляется таймером main.ts; в dry_run — фиксированная заглушка. */
  equity: string
}

/** Канал, чьи ключи не удалось применить: его сообщения не обрабатываются, остальные каналы живут. */
export interface UnavailableChannel {
  channelId: number
  reason: string
}

export interface AccountRegistry {
  /** Рантайм канала; null — ключи канала непригодны (см. unavailable). */
  forChannel(channelId: number): AccountRuntime | null
  all(): AccountRuntime[]
  unavailable(): UnavailableChannel[]
}

/** Первые 8 символов sha256 от ключа — достаточно, чтобы различать аккаунты в логах. */
export function accountFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 8)
}

export interface BuildRegistryOptions {
  db: Kysely<DB>
  network: Network
  /** Каналы, которые обслуживает движок (те же, что перебирает tick()). */
  channelIds: readonly number[]
  /** Стартовое значение equity рантайма (реальное подтянет таймер main.ts). */
  initialEquity: string
  /** Подмена в тестах: по умолчанию — реальные ключи канала с фолбэком на env. */
  loadKeys?: (db: Kysely<DB>, channelId: number | null) => Promise<ChannelKeys>
  /** Подмена в тестах: сборка клиентов аккаунта. */
  createRuntime?: (params: CreateRuntimeParams) => Omit<AccountRuntime, 'channelIds' | 'equity'>
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface CreateRuntimeParams {
  db: Kysely<DB>
  network: Network
  keys: ChannelKeys
  fingerprint: string
  shared: boolean
  /** Каналы этого аккаунта — приватный WS ограничивает ими атрибуцию пушей. */
  channelIds: number[]
}

function defaultCreateRuntime(params: CreateRuntimeParams): Omit<AccountRuntime, 'channelIds' | 'equity'> {
  const rest = new BybitRestClient({ apiKey: params.keys.apiKey, apiSecret: params.keys.apiSecret, network: params.network })
  const privateWs = new BybitPrivateWs({
    apiKey: params.keys.apiKey,
    apiSecret: params.keys.apiSecret,
    network: params.network,
    db: params.db,
    rest,
    nowMs: () => rest.serverNowMs(),
    channelIds: params.channelIds,
  })
  return {
    fingerprint: params.fingerprint,
    shared: params.shared,
    rest,
    executionPort: createExecutionPort('live', { rest, network: params.network }),
    privateWs,
  }
}

/**
 * Собирает реестр: читает ключи каждого канала, группирует каналы по аккаунту, поднимает по одному
 * набору клиентов на аккаунт.
 *
 * Канал с непригодными ключами (сменили ENCRYPTION_KEY, битая строка) НЕ обслуживается, но не
 * роняет остальные: один испорченный ключ не должен останавливать торговлю всех каналов.
 */
export async function buildAccountRegistry(options: BuildRegistryOptions): Promise<AccountRegistry> {
  const loadKeys = options.loadKeys ?? getChannelKeys
  const createRuntime = options.createRuntime ?? defaultCreateRuntime
  const log = options.log ?? console

  // Ключи общего аккаунта читаем один раз: с ними сравниваем ключи каналов, чтобы понять, свой у
  // канала аккаунт или тот же самый (тогда он попадёт в общий рантайм, а не в свой собственный).
  const sharedKeys = await loadKeys(options.db, null).catch((err: unknown) => {
    log.warn(`[accounts] общий аккаунт недоступен: ${String(err)}`)
    return null
  })
  const sharedFingerprint = sharedKeys ? accountFingerprint(sharedKeys.apiKey) : null

  const byFingerprint = new Map<string, { keys: ChannelKeys; channelIds: number[] }>()
  const unavailable: UnavailableChannel[] = []

  for (const channelId of options.channelIds) {
    let keys: ChannelKeys
    try {
      keys = await loadKeys(options.db, channelId)
    } catch (err) {
      unavailable.push({ channelId, reason: String(err) })
      log.error(`[accounts] канал ${channelId} без рабочих ключей — сообщения обрабатываться не будут: ${String(err)}`)
      continue
    }
    const fingerprint = accountFingerprint(keys.apiKey)
    const existing = byFingerprint.get(fingerprint)
    if (existing) existing.channelIds.push(channelId)
    else byFingerprint.set(fingerprint, { keys, channelIds: [channelId] })
  }

  const runtimes: AccountRuntime[] = []
  const byChannel = new Map<number, AccountRuntime>()

  for (const [fingerprint, group] of byFingerprint) {
    const runtime: AccountRuntime = {
      ...createRuntime({
        db: options.db,
        network: options.network,
        keys: group.keys,
        fingerprint,
        shared: fingerprint === sharedFingerprint,
        channelIds: group.channelIds,
      }),
      channelIds: group.channelIds,
      equity: options.initialEquity,
    }
    runtimes.push(runtime)
    for (const channelId of group.channelIds) byChannel.set(channelId, runtime)
    log.log(
      `[accounts] аккаунт ${fingerprint}${runtime.shared ? ' (общий из env)' : ''} обслуживает каналы: ${group.channelIds.join(', ')}`,
    )
  }

  return {
    forChannel: (channelId) => byChannel.get(channelId) ?? null,
    all: () => runtimes,
    unavailable: () => unavailable,
  }
}
