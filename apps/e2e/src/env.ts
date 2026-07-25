import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { resolveChannelSources, type ChannelSource } from 'shared/sources.js'
import type { Network } from 'shared/domain.js'

// Тот же приём, что и в apps/*/src/main.ts: пакет запускается из apps/e2e, а .env лежит в корне
// репозитория — process.env его сам не подхватывает. Корневая обёртка (scripts/e2e.mjs) уже
// стартует node с --env-file-if-exists, эта строка страхует прямой запуск `tsx src/cli.ts`.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

/** Слот канала = ord БОЕВОГО канала, который подменён (1 = ch1-structured, 2 = ch2-freeform). */
export type ChannelSlot = 1 | 2

export interface E2eChannel {
  slot: ChannelSlot
  /** channels.id в БД = «сырой» id канала Telegram. */
  id: number
  tgId: bigint
  key: string
  adapterId: string
  topicId: number | null
}

export interface E2eConfig {
  databaseUrl: string
  network: Network
  executionMode: string
  telegram: {
    apiId: number
    apiHash: string
    /** Сессия воркера (та же, что слушает каналы) — из неё авторизуется сессия постера. */
    session: string
    /**
     * Сессия ПОСТЕРА. Отдельный auth-key того же аккаунта (`pnpm e2e session`): с общей строкой
     * сессии tg-ingest теряет realtime — см. подробности в session.ts/tg.ts. Пусто — работаем на
     * общей сессии с предупреждением в doctor.
     */
    posterSession: string | null
  }
  bybit: { apiKey: string; apiSecret: string }
  aiProxyUrl: string
  apiUrl: string
  channels: E2eChannel[]
  /** Смещение ord тестовых каналов (sources.ts OVERRIDE_ORD_OFFSET) — обратный пересчёт в слот. */
  maxEntrySlippagePct: string
}

const OVERRIDE_ORD_OFFSET = 100

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`e2e: ${name} не задан в .env`)
  }
  return value
}

/**
 * Конфиг e2e + ЗАЩИТНЫЕ ГЕЙТЫ. Весь смысл этого прогона — реальные ордера, поэтому падать надо
 * ДО первого сетевого вызова, а не посреди сценария:
 *  - mainnet запрещён явно (единственные разрешённые сети — demo и testnet);
 *  - без TG_CHANNEL_OVERRIDES слушаются БОЕВЫЕ каналы, и наш тестовый пост ушёл бы в никуда,
 *    а живой сигнал автора — в реальную сделку посреди прогона (sources.ts об этом же).
 */
export function loadE2eConfig(): E2eConfig {
  const networkRaw = process.env.BYBIT_NETWORK ?? 'testnet'
  if (networkRaw === 'mainnet') {
    throw new Error('e2e: BYBIT_NETWORK=mainnet — отказ. E2E ставит РЕАЛЬНЫЕ ордера, допустимы только demo/testnet.')
  }
  const network: Network = networkRaw === 'demo' ? 'demo' : 'testnet'

  const sources = resolveChannelSources(process.env)
  const testSources = sources.filter((s: ChannelSource) => s.isTest === true)
  if (testSources.length === 0) {
    throw new Error(
      'e2e: TG_CHANNEL_OVERRIDES пуст — бот слушает БОЕВЫЕ каналы. Задайте свои каналы в .env (см. .env.example) и перезапустите стек.',
    )
  }

  const channels: E2eChannel[] = testSources.map((s) => ({
    slot: (s.ord - OVERRIDE_ORD_OFFSET) as ChannelSlot,
    id: Number(s.channelId),
    tgId: s.channelId,
    key: s.key,
    adapterId: s.adapterId,
    topicId: s.topicId,
  }))

  return {
    databaseUrl: required('DATABASE_URL'),
    network,
    executionMode: process.env.EXECUTION_MODE ?? 'dry_run',
    telegram: {
      apiId: Number(required('TG_APP_API_ID')),
      apiHash: required('TG_APP_API_HASH'),
      session: required('TG_SESSION'),
      posterSession: process.env.E2E_TG_SESSION?.trim() || null,
    },
    bybit: { apiKey: required('BYBIT_API_KEY'), apiSecret: required('BYBIT_API_SECRET') },
    // Прокси публикуется на хост как 127.0.0.1:8317 (docker-compose.yml); в .env лежит именно
    // хостовый URL (контейнерам его переопределяет compose) — для e2e, который бежит с хоста,
    // значение из .env верное как есть.
    aiProxyUrl: process.env.AI_PROXY_URL ?? 'http://127.0.0.1:8317',
    apiUrl: process.env.E2E_API_URL ?? 'http://127.0.0.1:5173/api',
    channels,
    maxEntrySlippagePct: process.env.MAX_ENTRY_SLIPPAGE_PCT || '0.5',
  }
}

export function channelBySlot(config: E2eConfig, slot: ChannelSlot): E2eChannel {
  const channel = config.channels.find((c) => c.slot === slot)
  if (!channel) {
    const known = config.channels.map((c) => `${c.slot} (${c.adapterId})`).join(', ') || '—'
    throw new Error(`e2e: канал слота ${slot} не подменён в TG_CHANNEL_OVERRIDES. Доступны: ${known}`)
  }
  return channel
}
