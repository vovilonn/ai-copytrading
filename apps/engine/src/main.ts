import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import type { Kysely } from 'kysely'
import { loadConfig } from 'api/config/config.schema.js'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { createExecutionPort } from './execution/port.js'
import { TickersFeed } from './market-data/tickers-feed.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from './pipeline.js'

// Запускается из apps/engine (pnpm --filter engine dev), а .env лежит в корне репозитория —
// тот же приём, что apps/tg-ingest/src/main.ts и apps/api/src/main.ts.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

// Ф2 (задача 7, task-7-brief.md): форум `1962583820` (adapter ch2-freeform) включён в обработку
// НАРАВНЕ с CH1 (2088626562) — AI-слой (задача 4) и деградация fail-safe уже готовы (pipeline.ts:
// route==='ai' -> runAiBranch). Фильтр по adapter_id остаётся (защита от неизвестного будущего
// адаптера без парсера — getAdapter() иначе бросил бы исключение и сорвал бы тик остальным
// каналам, см. tick() ниже), но теперь это список ОБОИХ известных адаптеров, а не один
// детерминированный CH1: маршрутизация "детерминированный/AI" внутри канала — забота
// adapter.parse()/reconcile() внутри processMessage, не этого тика. withChannelLock (ниже)
// по-прежнему держит строгий последовательный порядок ВНУТРИ каждого канала независимо —
// отказ AI на форуме (ai_unavailable) не блокирует и не замедляет обработку CH1 в том же тике.
const KNOWN_ADAPTER_IDS = ['ch1-structured', 'ch2-freeform'] as const

const POLL_INTERVAL_MS = 5000
const BATCH_SIZE = 50
// Тот же канал NOTIFY, что и у outbox api (apps/tg-ingest шлёт pg_notify('domain_events', '')
// при появлении нового сообщения) — engine просыпается на то же уведомление, что и api.
const NOTIFY_CHANNEL = 'domain_events'
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

/**
 * Держит `pg_advisory_lock` (сессионный, НЕ транзакционный) на отдельном соединении на всё время
 * обработки одной пачки канала — гарантирует строгий порядок обработки канала даже при
 * гипотетической второй реплике engine (research backend-architecture.md §5: "одна логическая
 * lane на канал"). `pg_try_advisory_lock` не блокируется: если канал уже занят другой сессией —
 * просто пропускаем этот тик, следующий (по таймеру или NOTIFY) подхватит.
 */
async function withChannelLock(databaseUrl: string, channelId: number, fn: () => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const key = `chan:${channelId}`
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])
    if (!rows[0]?.locked) return
    try {
      await fn()
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
    }
  } finally {
    await client.end()
  }
}

/**
 * Строго последовательная обработка одного канала: забирает пачку `received`-сообщений по
 * возрастанию `tg_message_id` и прогоняет их через `processMessage` строго по одному (не
 * `Promise.all` — порядок важен, каждое сообщение видит эффект предыдущего через `positions`).
 */
async function processChannel(db: Kysely<DB>, channelId: number, deps: PipelineDeps): Promise<void> {
  const rows = await db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', channelId)
    .where('status', '=', 'received')
    .orderBy('tg_message_id', 'asc')
    .limit(BATCH_SIZE)
    .forUpdate()
    .skipLocked()
    .execute()
  // ВНИМАНИЕ: FOR UPDATE вне явной транзакции — Postgres оборачивает одиночный SELECT в неявную
  // транзакцию, и лок снимается сразу после него. Настоящую защиту от двойной обработки при
  // гипотетической второй реплике даёт advisory-lock канала (withChannelLock — держит СЕССИЮ на
  // время всей пачки); SKIP LOCKED здесь — дополнительный, не единственный барьер (design spec §5).
  for (const row of rows) {
    const message: PipelineMessage = {
      id: row.id,
      channelId: row.channel_id,
      tgMessageId: row.tg_message_id,
      replyToMsgId: row.reply_to_msg_id,
      groupedId: row.grouped_id,
      text: row.text,
      mediaKind: row.media_kind,
      msgTs: row.msg_ts,
    }
    await processMessage(db, message, deps)
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  await migrateToLatest(db)

  const executionPort = createExecutionPort(config.executionMode)
  const deps: PipelineDeps = { executionPort, network: config.bybitNetwork, equity: '1000' }

  // Задача 10: публичный WS-фид mark price для символов с открытыми позициями — независим от
  // пайплайна разбора выше (не участвует в EXECUTION_MODE, публичный поток доступен без ключа
  // и в dry-run, см. task-10-brief.md).
  const tickersFeed = new TickersFeed(db, config.bybitNetwork)

  let stopped = false
  let draining = false
  let pollTimer: NodeJS.Timeout | null = null
  let listenClient: pg.Client | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let reconnectDelayMs = RECONNECT_BASE_MS

  async function tick(): Promise<void> {
    if (draining) return
    draining = true
    try {
      const channels = await db
        .selectFrom('channels')
        .select('id')
        .where('adapter_id', 'in', KNOWN_ADAPTER_IDS)
        .where('status', '=', 'active')
        .execute()
      for (const { id: channelId } of channels) {
        await withChannelLock(config.databaseUrl, channelId, () => processChannel(db, channelId, deps))
      }
    } catch (err) {
      console.error('[engine] ошибка тика обработки:', err)
    } finally {
      draining = false
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return
    if (listenClient) {
      const client = listenClient
      listenClient = null
      client.removeAllListeners()
      client.end().catch(() => {})
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectListener().catch((err) => {
        console.error('[engine] реконнект LISTEN не удался:', err)
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS)
        scheduleReconnect()
      })
    }, reconnectDelayMs)
  }

  async function connectListener(): Promise<void> {
    const client = new pg.Client({ connectionString: config.databaseUrl })
    client.on('error', (err) => {
      console.warn('[engine] соединение LISTEN оборвалось:', err.message)
      scheduleReconnect()
    })
    client.on('notification', (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL) return
      tick().catch((err) => console.error('[engine] обработка NOTIFY:', err))
    })
    await client.connect()
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`)
    listenClient = client
    reconnectDelayMs = RECONNECT_BASE_MS
    console.log(`[engine] LISTEN ${NOTIFY_CHANNEL} активен`)
    // На старте и после каждого реконнекта могло накопиться необработанное — тот же путь, что и NOTIFY.
    await tick()
  }

  await connectListener()
  pollTimer = setInterval(() => {
    tick().catch((err) => console.error('[engine] периодический опрос:', err))
  }, POLL_INTERVAL_MS)
  tickersFeed.start()

  console.log(`[engine] воркер запущен: пайплайн разбора и исполнения (${config.executionMode}) активен`)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    stopped = true
    console.log(`[engine] получен ${signal}, завершаюсь...`)
    if (pollTimer) clearInterval(pollTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    tickersFeed.stop()
    const closeListener = listenClient ? listenClient.end().catch(() => {}) : Promise.resolve()
    closeListener
      .then(() => db.destroy())
      .then(() => {
        console.log('[engine] остановлен корректно')
        process.exit(0)
      })
      .catch((err) => {
        console.error('[engine] ошибка при остановке:', err)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Одиночная сетевая флуктуация (обрыв LISTEN-соединения, keepalive и т.п.) не должна ронять
// процесс — логируем и живём дальше (тот же приём, что apps/tg-ingest/src/main.ts).
process.on('unhandledRejection', (reason) => {
  console.error('[engine] unhandledRejection:', reason)
})

main().catch((err) => {
  console.error('[engine] фатальная ошибка при старте:', err)
  process.exitCode = 1
})
