import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import { sql, type Kysely } from 'kysely'
import { loadConfig } from 'api/config/config.schema.js'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Network } from 'shared/domain.js'
import { createExecutionPort, type ExecutionPort } from './execution/port.js'
import { BybitRestClient } from './bybit/rest-client.js'
import { BybitPrivateWs } from './bybit/private-ws.js'
import { reconcileOnStart, type ReconcileResult } from './bybit/reconcile.js'
import { getEquity } from './state/equity.js'
import { getChannelKeys } from './bybit/channel-keys.js'
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

// Задача 5 (Ф3, live-режим): интервалы планировщика. TTL-свип — "раз в час" (бриф задачи,
// защитный потолок §9 — не основной механизм отмены, спешить некуда); реконсиляция дрейфа и
// рефреш equity — только в live, "раз в ~10 мин"/по TTL кэша getEquity соответственно.
const TTL_SWEEP_INTERVAL_MS = 60 * 60 * 1000
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000
// Совпадает с DEFAULT_TTL_MS кэша state/equity.ts — рефреш чаще бессмысленен (getEquity вернул бы
// то же кэшированное значение), реже — equity в сайзинге отставал бы от биржи дольше, чем нужно.
const EQUITY_REFRESH_INTERVAL_MS = 30_000
// dry_run-заглушка equity (см. PipelineDeps.equity в pipeline.ts — "совпадает с суммой, которой
// реально пополнен testnet-аккаунт"); live использует реальный getEquity(rest) ниже.
const DRY_RUN_EQUITY = '1000'
// Important I2 адверсариального ревью (p3-core-fix-report.md): порог гейта staleness/slippage
// перед market-входом (pipeline.ts::handleEntrySignal) — читается напрямую из process.env (не
// через api/config/config.schema.ts — эта задача не трогает apps/api), с дефолтом '0.5' (0.5%),
// если переменная не задана/пуста. Применяется в ОБОИХ режимах одинаково (не ветвится по
// EXECUTION_MODE) — сам гейт в pipeline.ts уже условен на наличие deps.getMarkPrice (только live).
const MAX_ENTRY_SLIPPAGE_PCT = process.env.MAX_ENTRY_SLIPPAGE_PCT || '0.5'

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

export interface LiveRuntime {
  executionPort: ExecutionPort
  privateWs: BybitPrivateWs
  reconcileResult: ReconcileResult
}

/** Минимальный контракт rest-клиента, нужный `createMarkPriceGetter` — тестируется мок-объектом
 *  без реального `BybitRestClient` (тот же приём, что `BybitAdapterRestClient`/`ReconcileRestClient`). */
export interface MarkPriceRestClient {
  getTicker(symbol: string): Promise<{ markPrice: string; lastPrice: string }>
}

/**
 * Фикс p3-slippage-fix (Important, найден e2e): живой mark price для гейта staleness/slippage I2
 * (pipeline.ts::handleEntrySignal) — берётся из ПУБЛИЧНОГО тикера `GET /v5/market/tickers`
 * (rest-client.ts::getTicker), а НЕ из стаб-позиции `position/list`. Стаб-позиция при size=0
 * несёт markPrice ТОЛЬКО если на аккаунте когда-либо была история по символу — на "холодном"
 * testnet-аккаунте без прежних позиций возвращает `markPrice=""` (LOOP_STATE.md, находка
 * предыдущего лупа), из-за чего гейт молча fail-open на первом входе по любому новому символу.
 * Публичный тикер не зависит от истории аккаунта — всегда несёт актуальную цену торгуемого
 * символа, ключ/подпись не нужны (rest-client.ts::publicGet).
 *
 * Возвращает `null` ТОЛЬКО при полном сбое (сеть/исключение/пустые markPrice И lastPrice) —
 * pipeline.ts теперь трактует `null` как fail-CLOSED (skip `mark_price_unavailable`), а не
 * fail-open: если мы не можем достоверно узнать текущую цену, вход по протухшему сигналу
 * опаснее, чем пропущенный вход (design spec: "не входить вслепую").
 */
export function createMarkPriceGetter(rest: MarkPriceRestClient): (symbol: string) => Promise<string | null> {
  return async (symbol: string): Promise<string | null> => {
    try {
      const ticker = await rest.getTicker(symbol)
      const price = ticker.markPrice || ticker.lastPrice
      return price ? price : null
    } catch (err) {
      console.error(`[engine] getMarkPrice(${symbol}) для гейта slippage:`, err)
      return null
    }
  }
}

/**
 * Единая точка ветвления EXECUTION_MODE внутри main.ts (design spec §14: "EXECUTION_MODE —
 * единственная точка ветвления... никаких if(dryRun) по коду"): main() (ниже) — ЕДИНСТВЕННЫЙ
 * `if` по режиму в этом файле, а эта функция поднимает live-ресурсы в порядке брифа задачи 5 —
 * реконсиляция → приватный WS → ExecutionPort. dry_run вообще не заходит сюда. Второе (парное)
 * место ветвления — фабрика `createExecutionPort` (execution/port.ts): pipeline.ts и сами адаптеры
 * не содержат ни одного `if` по режиму.
 *
 * `rest` конструируется ВЫЗЫВАЮЩЕЙ стороной (main() — реальным `BybitRestClient` с ключами канала/
 * env; тесты — мок-объектом с приведением типа `as unknown as BybitRestClient`, тот же приём, что
 * и `createExecutionPort` в bybit-adapter.test.ts) — так реконсиляция и фабрика тестируются без
 * реальной сети. `privateWs.start()` (реальный WebSocket-коннект) сознательно ОСТАЁТСЯ ЗА
 * пределами этой функции — вызывается отдельно в main() СРАЗУ после — тесты этой функции поэтому
 * не открывают сокет (private-ws.ts: `connect()` вызывается только из `start()`, конструктор сам
 * по себе безопасен).
 */
export async function initLiveRuntime(
  db: Kysely<DB>,
  rest: BybitRestClient,
  network: Network,
  keys: { apiKey: string; apiSecret: string },
): Promise<LiveRuntime> {
  const reconcileResult = await reconcileOnStart(db, rest)
  console.log(
    `[engine] reconcileOnStart: opened=${reconcileResult.opened} closed=${reconcileResult.closed} ` +
      `flagged=${reconcileResult.flagged} orphansCancelled=${reconcileResult.orphansCancelled} ` +
      `reattributedExecutions=${reconcileResult.reattributedExecutions}`,
  )
  const privateWs = new BybitPrivateWs({ apiKey: keys.apiKey, apiSecret: keys.apiSecret, network, db, rest })
  const executionPort = createExecutionPort('live', { rest, network })
  return { executionPort, privateWs, reconcileResult }
}

/**
 * TTL-свип отложенных лимиток (design spec §9 / research bybit-execution.md §9, task-5-brief.md):
 * entry/add-лимитка в статусе 'submitted' старше `ttl_expires_at` (если явно проставлен) ИЛИ
 * `created_at + channel_settings.limit_ttl_sec` (дефолт 604800с = 7 дней) — отменяется.
 * TTL — "защитный потолок, а не основной механизм" (design spec §9): явное «лимитка не
 * актуальна» (delta-op `cancel_pending`, уже реализован в pipeline.ts::handleDelta) отменяет
 * РАНЬШЕ этого срока — эта функция ловит только то, что НЕ было отменено явно.
 *
 * TP/SL/close НЕ входят в выборку (`purpose IN ('entry','add')`) — это не "отложенные лимитки"
 * §9, а протекторы уже открытой позиции, TTL на них design spec не распространяет.
 *
 * НИКАКОГО ветвления по режиму здесь — `executionPort.cancelOrder` уже сам по себе делает
 * правильную вещь в обоих режимах (единая точка ветвления — фабрика createExecutionPort):
 * DryRunAdapter молча помечает cancelled в БД (биржи нет), BybitAdapter реально зовёт
 * `rest.cancelOrder` и только потом помечает БД. Поэтому TTL-свип вызывается из main() БЕЗУСЛОВНО,
 * не только в live-ветке (см. бриф задачи: "в dry_run — просто помечать cancelled в БД").
 *
 * @returns число отменённых ордеров (для лога планировщика).
 */
export async function sweepExpiredLimitOrders(db: Kysely<DB>, executionPort: ExecutionPort, now: Date = new Date()): Promise<number> {
  const expired = await db
    .selectFrom('orders')
    .innerJoin('channel_settings', 'channel_settings.channel_id', 'orders.channel_id')
    .select(['orders.order_link_id as orderLinkId'])
    .where('orders.purpose', 'in', ['entry', 'add'])
    .where('orders.order_type', '=', 'limit')
    .where('orders.status', '=', 'submitted')
    .where(
      sql<boolean>`COALESCE(orders.ttl_expires_at, orders.created_at + make_interval(secs => channel_settings.limit_ttl_sec)) <= ${now}`,
    )
    .execute()

  for (const row of expired) {
    // Один ордер — одна транзакция (не пачкой): cancelOrder(tx,...) сам решает, filled/cancelled
    // ли уже ордер (идемпотентно) — крэш посреди свипа отменяет то, что успел, остальное подхватит
    // следующий тик планировщика, не оставляя "половину" эффекта одной строки.
    await db.transaction().execute((trx) => executionPort.cancelOrder(trx, { orderLinkId: row.orderLinkId }))
  }
  return expired.length
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  await migrateToLatest(db)

  // EXECUTION_MODE — единственная точка ветвления в этом файле (design spec §14): live поднимает
  // реальный REST-клиент/реконсиляцию/приватный WS ДО первого тика пайплайна; dry_run — как раньше,
  // без единого сетевого похода к Bybit (задача не должна ничего сломать в dry_run пути).
  let executionPort: ExecutionPort
  let liveRest: BybitRestClient | null = null
  let privateWs: BybitPrivateWs | null = null
  let initialEquity = DRY_RUN_EQUITY
  // Important I2: undefined в dry_run — гейт в pipeline.ts::handleEntrySignal вообще не
  // вызывается, если это поле не задано (нет сети в dry_run, тот же принцип, что и initialEquity
  // выше) — это единственный fail-open случай. В live поле ВСЕГДА задано (createMarkPriceGetter
  // ниже); если сам вызов вернёт null (сбой похода за ценой) — фикс p3-slippage-fix делает гейт
  // fail-CLOSED (pipeline.ts: skip mark_price_unavailable), а не fail-open.
  let getMarkPrice: PipelineDeps['getMarkPrice']

  if (config.executionMode === 'live') {
    // Ф3: одно окружение → все каналы (channels.bybit_api_key_enc/secret_enc сегодня всегда NULL,
    // channel-seed.service.ts) — getChannelKeys(db, null) сразу берёт BYBIT_API_KEY/SECRET из env,
    // не угадывая "какой канал главный". Per-channel субаккаунты — готовая структура, не мандат Ф3.
    const keys = await getChannelKeys(db, null)
    liveRest = new BybitRestClient({ apiKey: keys.apiKey, apiSecret: keys.apiSecret, network: config.bybitNetwork })
    const live = await initLiveRuntime(db, liveRest, config.bybitNetwork, keys)
    executionPort = live.executionPort
    privateWs = live.privateWs
    privateWs.start()
    initialEquity = (await getEquity(liveRest)).toString()
    console.log(`[engine] equity (wallet-balance totalEquity): ${initialEquity}`)

    // Important I2 / фикс p3-slippage-fix: живой mark price — публичный тикер (createMarkPriceGetter
    // выше), не стаб-позиция `position/list` (та отдаёт markPrice="" на аккаунте без истории по
    // символу — см. комментарий над createMarkPriceGetter). Сбой похода за ценой -> null -> гейт
    // теперь fail-CLOSED (pipeline.ts: skip mark_price_unavailable), не fail-open.
    getMarkPrice = createMarkPriceGetter(liveRest)
  } else {
    executionPort = createExecutionPort('dry_run')
  }

  const deps: PipelineDeps = {
    executionPort,
    network: config.bybitNetwork,
    equity: initialEquity,
    ...(getMarkPrice ? { getMarkPrice } : {}),
    maxEntrySlippagePct: MAX_ENTRY_SLIPPAGE_PCT,
  }

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
  // Планировщик задачи 5: TTL-свип — оба режима; реконсиляция дрейфа/рефреш equity — только live.
  let ttlSweepTimer: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  let equityTimer: NodeJS.Timeout | null = null

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

  // TTL-свип — оба режима безусловно (sweepExpiredLimitOrders сам не ветвится по режиму, см.
  // комментарий над функцией выше).
  ttlSweepTimer = setInterval(() => {
    sweepExpiredLimitOrders(db, executionPort)
      .then((n) => {
        if (n > 0) console.log(`[engine] TTL-свип: отменено лимиток ${n}`)
      })
      .catch((err) => console.error('[engine] TTL-свип лимиток:', err))
  }, TTL_SWEEP_INTERVAL_MS)

  if (liveRest) {
    // Захват в const: `liveRest` объявлен как `let` выше, TS не сужает такую переменную внутри
    // замыканий setInterval (могла бы быть переприсвоена между определением и вызовом) — локальная
    // const убирает необходимость в `!`-assertion и гарантированно не null внутри таймеров.
    const rest = liveRest
    reconcileTimer = setInterval(() => {
      reconcileOnStart(db, rest)
        .then((result) =>
          console.log(
            `[engine] периодическая реконсиляция: opened=${result.opened} closed=${result.closed} ` +
              `flagged=${result.flagged} orphansCancelled=${result.orphansCancelled} ` +
              `reattributedExecutions=${result.reattributedExecutions}`,
          ),
        )
        .catch((err) => console.error('[engine] периодическая реконсиляция:', err))
    }, RECONCILE_INTERVAL_MS)

    equityTimer = setInterval(() => {
      getEquity(rest, { forceRefresh: true })
        .then((value) => {
          deps.equity = value.toString()
        })
        .catch((err) => console.error('[engine] рефреш equity:', err))
    }, EQUITY_REFRESH_INTERVAL_MS)
  }

  console.log(`[engine] воркер запущен: пайплайн разбора и исполнения (${config.executionMode}) активен`)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    stopped = true
    console.log(`[engine] получен ${signal}, завершаюсь...`)
    if (pollTimer) clearInterval(pollTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ttlSweepTimer) clearInterval(ttlSweepTimer)
    if (reconcileTimer) clearInterval(reconcileTimer)
    if (equityTimer) clearInterval(equityTimer)
    tickersFeed.stop()
    privateWs?.stop()
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

// Автозапуск ТОЛЬКО когда файл выполняется как entrypoint (`tsx src/main.ts` / `tsx watch ...`) —
// НЕ когда main-live.test.ts импортирует именованные экспорты (initLiveRuntime/sweepExpiredLimitOrders)
// этого же модуля: без этой проверки сам факт импорта поднимал бы весь движок (LISTEN/pollTimer/
// tickersFeed/live-подключение к Bybit) как побочный эффект юнит-теста. Стандартный ESM-приём
// "является ли этот модуль главным" — сравнение import.meta.url с process.argv[1].
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((err) => {
    console.error('[engine] фатальная ошибка при старте:', err)
    process.exitCode = 1
  })
}
