import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import { sql, type Kysely } from 'kysely'
import { loadConfig } from 'api/config/config.schema.js'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Network } from 'shared/domain.js'
import { createExecutionPort, type ExecutionPort } from './execution/port.js'
import { BybitApiError } from './bybit/rest-client.js'
import { reconcileOnStart, type ReconcileResult, type ReconcileScope } from './bybit/reconcile.js'
import { getEquity } from './state/equity.js'
import { writeWalletSnapshot } from './state/wallet-snapshot.js'
import { buildAccountRegistry, type AccountRegistry, type AccountRuntime } from './runtime/account-registry.js'
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
// Task 3 (мониторинг PnL/баланса, план 2026-07-12-monitoring-pnl-balance.md): писатель
// wallet_snapshots — ТОЛЬКО live (dry_run не имеет реального баланса, см. writeWalletSnapshot).
// ~30с — тот же порядок величины, что и EQUITY_REFRESH_INTERVAL_MS выше (баланс не успевает
// заметно измениться чаще, а история снапшотов не должна расти неограниченно быстро).
const WALLET_SNAPSHOT_INTERVAL_MS = 30_000
// dry_run-заглушка equity (см. PipelineDeps.equity в pipeline.ts — "совпадает с суммой, которой
// реально пополнен testnet-аккаунт"); live использует реальный getEquity(rest) ниже.
const DRY_RUN_EQUITY = '1000'
// Порог гейта «сигнал протух» перед рыночным входом (pipeline.ts::resolveEntryPrice).
//
// ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ (решение заказчика 08.08.2026: «постоянно прибыльные сделки теряю из-за
// этого условия — когда немного выходим из диапазона, сделка скипается»). Прежний дефолт 0.5%
// рубил вход, стоило рынку отойти от диапазона на полпроцента. Теперь вместо запрета — вход по
// живой цене: плечо/размер/ликвидация считаются от той цены, по которой реально пройдёт филл.
// Вернуть гейт: MAX_ENTRY_SLIPPAGE_PCT=0.5 (или другое число процентов) в окружении движка.
const MAX_ENTRY_SLIPPAGE_PCT = process.env.MAX_ENTRY_SLIPPAGE_PCT ?? ''

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
    try {
      await processMessage(db, message, deps)
    } catch (err) {
      // ЯДОВИТОЕ СООБЩЕНИЕ. Транзакция processMessage откатилась целиком — статус сообщения остался
      // 'received', и следующий тик (каждые 5 секунд) возьмёт его снова. Если отказ ПОСТОЯННЫЙ, это
      // вечный цикл: живой инцидент — «стоп в безубыток» на убыточной позиции, Bybit отвергал стоп
      // (retCode 10001), сообщение переигрывалось 108 раз, а в UI вечно крутился лоадер.
      //
      // Отличаем отказ БИРЖИ ПО СУЩЕСТВУ (retCode: цена стопа невалидна, ордер не существует, …) от
      // транзиентного сбоя (сеть/БД). Первый ретраить бессмысленно — сообщение уходит в needs_review
      // с причиной, оператор видит его в UI. Второй оставляем в 'received': следующий тик повторит.
      if (err instanceof BybitApiError) {
        console.error(
          `[engine] биржа отвергла исполнение сообщения ${message.tgMessageId} (retCode=${err.retCode}) — needs_review:`,
          err.retMsg,
        )
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('messages')
            .set({
              status: 'needs_review',
              status_reason: `exchange_rejected_${err.retCode}`,
              updated_at: new Date(),
            })
            .where('id', '=', message.id)
            .execute()

          // Иначе в UI навсегда останется лоадер «Разбираем сообщение…»: фронт снимает его по
          // 'message.updated', который api собирает как раз по этому событию.
          await trx
            .insertInto('domain_events')
            .values({
              type: 'message.processed',
              aggregate: 'message',
              aggregate_id: message.id,
              payload: JSON.stringify({ channelId: message.channelId, messageId: message.id }),
            })
            .execute()
        })
        await sql`SELECT pg_notify('domain_events', '')`.execute(db)
        continue
      }
      throw err // сеть/БД — пусть тик упадёт и повторит на следующей итерации
    }
  }
}

/** Снапшот баланса подписывается каналом ТОЛЬКО если аккаунт обслуживает ровно один канал —
 *  иначе цифра относится к аккаунту целиком, и приписывать её одному каналу было бы ложью. */
function walletSnapshotChannelId(runtime: AccountRuntime): number | null {
  return !runtime.shared && runtime.channelIds.length === 1 ? runtime.channelIds[0]! : null
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
 * Подъём ОДНОГО торгового аккаунта при старте live-движка: часы → сверка → приватный WS → equity →
 * снапшот баланса. Клиенты аккаунта уже собраны реестром (runtime/account-registry.ts), здесь —
 * только последовательность и её отказоустойчивость, поэтому функция тестируется подставным
 * рантаймом без сети.
 *
 * EXECUTION_MODE остаётся единственной точкой ветвления в main() (design spec §14): dry_run сюда
 * вообще не заходит, а pipeline.ts и адаптеры не содержат ни одного `if` по режиму.
 */
export async function startAccountRuntime(db: Kysely<DB>, runtime: AccountRuntime): Promise<ReconcileResult> {
  // Часы биржи — ДО первой подписи: локальные часы контейнера могут уехать (сон хоста/VM), и тогда
  // КАЖДЫЙ приватный запрос отвергается кодом 10002, а приватный WS не проходит auth — движок молча
  // слепнет (см. bybit/server-time.ts). Сбой самой синхронизации не критичен: поправка останется
  // нулевой, а 10002 форсирует повтор.
  const clockOffsetMs = await runtime.rest.syncClock()
  console.log(`[engine] аккаунт ${runtime.fingerprint}: часы биржи, поправка ${clockOffsetMs} мс`)

  // Сверка ограничена каналами ЭТОГО аккаунта: иначе она увидела бы сделки чужих каналов без
  // позиции на бирже (их позиции живут на другом аккаунте) и закрыла бы их. Сбой сверки НЕ должен
  // ронять движок: исключение отсюда уходило бы в main().catch → exitCode=1 → рестарт → снова тот
  // же вызов = crash-loop, при котором пайплайн не обрабатывает сообщения вообще. Живём дальше с
  // неполной сверкой — периодический проход (RECONCILE_INTERVAL_MS) повторит попытку.
  const result = await reconcileOnStart(db, runtime.rest, reconcileScope(runtime)).catch((err): ReconcileResult => {
    console.error(`[engine] reconcileOnStart аккаунта ${runtime.fingerprint} не удалась:`, err)
    return { opened: 0, closed: 0, flagged: 0, orphansCancelled: 0, reattributedExecutions: 0, phantomsZeroed: 0, degraded: true }
  })
  console.log(
    `[engine] reconcileOnStart ${runtime.fingerprint}: opened=${result.opened} closed=${result.closed} ` +
      `flagged=${result.flagged} orphansCancelled=${result.orphansCancelled} ` +
      `reattributedExecutions=${result.reattributedExecutions} phantomsZeroed=${result.phantomsZeroed}` +
      (result.degraded ? ' (DEGRADED: сверка не выполнена)' : ''),
  )

  runtime.privateWs.start()
  runtime.equity = (await getEquity(runtime.rest)).toString()
  console.log(`[engine] аккаунт ${runtime.fingerprint}: equity ${runtime.equity}`)

  try {
    await writeWalletSnapshot(db, runtime.rest, walletSnapshotChannelId(runtime))
  } catch (err) {
    console.error(`[engine] writeWalletSnapshot (старт, аккаунт ${runtime.fingerprint}):`, err)
  }

  return result
}

/**
 * Скоуп сверки аккаунта: свои каналы + свой водяной знак догона истории. Общий (env) аккаунт
 * сохраняет ПРЕЖНИЙ ключ курсора без fingerprint — иначе первый же старт после обновления
 * перечитал бы всю историю прода заново.
 */
function reconcileScope(runtime: AccountRuntime): ReconcileScope {
  return {
    channelIds: runtime.channelIds,
    ...(runtime.shared ? {} : { accountFingerprint: runtime.fingerprint }),
  }
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
export async function sweepExpiredLimitOrders(
  db: Kysely<DB>,
  /**
   * Порт КАНАЛА, а не движка: с субаккаунтами лимитку канала может отменить только клиент его
   * аккаунта — чужими ключами Bybit просто не найдёт этот ордер (110001). Функция получает
   * резолвер, а не готовый порт; `null` от резолвера означает «канал не обслуживается» — такие
   * ордера пропускаем, их отменит следующий свип после починки ключей.
   */
  portForChannel: (channelId: number) => ExecutionPort | null,
  now: Date = new Date(),
): Promise<number> {
  const expired = await db
    .selectFrom('orders')
    .innerJoin('channel_settings', 'channel_settings.channel_id', 'orders.channel_id')
    .select(['orders.order_link_id as orderLinkId', 'orders.channel_id as channelId'])
    .where('orders.purpose', 'in', ['entry', 'add'])
    .where('orders.order_type', '=', 'limit')
    .where('orders.status', '=', 'submitted')
    .where(
      sql<boolean>`COALESCE(orders.ttl_expires_at, orders.created_at + make_interval(secs => channel_settings.limit_ttl_sec)) <= ${now}`,
    )
    .execute()

  let cancelled = 0
  for (const row of expired) {
    const port = portForChannel(row.channelId)
    if (!port) continue
    // Один ордер — одна транзакция (не пачкой): cancelOrder(tx,...) сам решает, filled/cancelled
    // ли уже ордер (идемпотентно) — крэш посреди свипа отменяет то, что успел, остальное подхватит
    // следующий тик планировщика, не оставляя "половину" эффекта одной строки.
    await db.transaction().execute((trx) => port.cancelOrder(trx, { orderLinkId: row.orderLinkId }))
    cancelled++
  }
  return cancelled
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  await migrateToLatest(db)

  // EXECUTION_MODE — единственная точка ветвления в этом файле (design spec §14): live поднимает
  // реальный REST-клиент/реконсиляцию/приватный WS ДО первого тика пайплайна; dry_run — как раньше,
  // без единого сетевого похода к Bybit (задача не должна ничего сломать в dry_run пути).
  let executionPort: ExecutionPort

  // Реестр аккаунтов (runtime/account-registry.ts): у каждого канала может быть СВОЙ субаккаунт
  // Bybit. Каналы без собственных ключей обслуживает общий аккаунт из BYBIT_API_KEY — поведение до
  // появления субаккаунтов, поэтому существующий прод продолжает работать без единого действия.
  let registry: AccountRegistry | null = null

  if (config.executionMode === 'live') {
    const liveChannels = await db
      .selectFrom('channels')
      .select('id')
      .where('adapter_id', 'in', KNOWN_ADAPTER_IDS)
      .where('status', '=', 'active')
      .execute()

    registry = await buildAccountRegistry({
      db,
      network: config.bybitNetwork,
      channelIds: liveChannels.map((c) => c.id),
      initialEquity: DRY_RUN_EQUITY,
    })

    for (const runtime of registry.all()) {
      await startAccountRuntime(db, runtime)
    }

    for (const { channelId, reason } of registry.unavailable()) {
      console.error(`[engine] канал ${channelId} пропускается: ${reason}`)
    }

    // Порт по умолчанию (каналы вне реестра его не получат — их сообщения не обрабатываются).
    executionPort = registry.all()[0]?.executionPort ?? createExecutionPort('dry_run')
  } else {
    executionPort = createExecutionPort('dry_run')
  }

  /**
   * Зависимости пайплайна ДЛЯ КОНКРЕТНОГО КАНАЛА: порт исполнения, equity и источник цены берутся
   * у аккаунта этого канала. Раньше объект был один на весь движок — с субаккаунтами это означало
   * бы, что ордер канала уходит чужими ключами, а риск считается от чужого депозита.
   *
   * `null` — канал не обслуживается (нет рабочих ключей): его сообщения пропускаются до тех пор,
   * пока оператор не поправит ключи и не перезапустит движок.
   */
  function depsForChannel(channelId: number): PipelineDeps | null {
    if (config.executionMode !== 'live') {
      return {
        executionPort,
        network: config.bybitNetwork,
        equity: DRY_RUN_EQUITY,
        maxEntrySlippagePct: MAX_ENTRY_SLIPPAGE_PCT,
      }
    }
    const runtime = registry?.forChannel(channelId) ?? null
    if (!runtime) return null
    return {
      executionPort: runtime.executionPort,
      network: config.bybitNetwork,
      equity: runtime.equity,
      availableBalance: runtime.availableBalance,
      getMarkPrice: createMarkPriceGetter(runtime.rest),
      maxEntrySlippagePct: MAX_ENTRY_SLIPPAGE_PCT,
    }
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
  let walletSnapshotTimer: NodeJS.Timeout | null = null

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
        const channelDeps = depsForChannel(channelId)
        if (!channelDeps) continue // канал без рабочих ключей — уже залогирован при старте
        await withChannelLock(config.databaseUrl, channelId, () => processChannel(db, channelId, channelDeps))
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
    sweepExpiredLimitOrders(db, (channelId) => depsForChannel(channelId)?.executionPort ?? null)
      .then((n) => {
        if (n > 0) console.log(`[engine] TTL-свип: отменено лимиток ${n}`)
      })
      .catch((err) => console.error('[engine] TTL-свип лимиток:', err))
  }, TTL_SWEEP_INTERVAL_MS)

  if (registry) {
    const runtimes = registry.all()
    // Проходы не должны накладываться: сверка ходит в сеть и с догоном истории легко переживёт свой
    // интервал. Тот же приём, что `draining` у tick(), но теперь на КАЖДЫЙ аккаунт свой флаг.
    const reconciling = new Set<string>()
    reconcileTimer = setInterval(() => {
      for (const runtime of runtimes) {
        if (reconciling.has(runtime.fingerprint)) {
          console.warn(`[engine] реконсиляция аккаунта ${runtime.fingerprint} ещё идёт — пропускаю тик`)
          continue
        }
        reconciling.add(runtime.fingerprint)
        reconcileOnStart(db, runtime.rest, reconcileScope(runtime))
          .then((result) =>
            console.log(
              `[engine] периодическая реконсиляция ${runtime.fingerprint}: opened=${result.opened} closed=${result.closed} ` +
                `flagged=${result.flagged} orphansCancelled=${result.orphansCancelled} ` +
                `reattributedExecutions=${result.reattributedExecutions} phantomsZeroed=${result.phantomsZeroed}`,
            ),
          )
          .catch((err) => console.error(`[engine] периодическая реконсиляция ${runtime.fingerprint}:`, err))
          .finally(() => reconciling.delete(runtime.fingerprint))
      }
    }, RECONCILE_INTERVAL_MS)

    equityTimer = setInterval(() => {
      for (const runtime of runtimes) {
        getEquity(runtime.rest, { forceRefresh: true })
          .then((value) => {
            // Пайплайн читает equity через depsForChannel на каждом тике — достаточно обновить
            // поле рантайма, пересобирать deps не нужно.
            runtime.equity = value.toString()
          })
          .catch((err) => console.error(`[engine] рефреш equity ${runtime.fingerprint}:`, err))
        // Свободная маржа — отдельным полем: именно её проверяет биржа при новом ордере, и она
        // может быть в разы меньше депозита (см. AccountRuntime.availableBalance).
        runtime.rest
          .getWalletBalance()
          .then((balance) => {
            if (balance.totalAvailableBalance !== '') runtime.availableBalance = balance.totalAvailableBalance
          })
          .catch((err) => console.error(`[engine] рефреш свободной маржи ${runtime.fingerprint}:`, err))
      }
    }, EQUITY_REFRESH_INTERVAL_MS)

    walletSnapshotTimer = setInterval(() => {
      for (const runtime of runtimes) {
        writeWalletSnapshot(db, runtime.rest, walletSnapshotChannelId(runtime)).catch((err) =>
          console.error(`[engine] writeWalletSnapshot (планировщик, ${runtime.fingerprint}):`, err),
        )
      }
    }, WALLET_SNAPSHOT_INTERVAL_MS)
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
    if (walletSnapshotTimer) clearInterval(walletSnapshotTimer)
    tickersFeed.stop()
    for (const runtime of registry?.all() ?? []) runtime.privateWs.stop()
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
