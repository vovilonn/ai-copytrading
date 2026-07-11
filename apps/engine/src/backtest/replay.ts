import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { Decimal } from 'decimal.js'
import { FileMigrationProvider, Kysely, Migrator, PostgresDialect, sql, type Insertable } from 'kysely'
import { createDb, type DB } from 'api/db/database.js'
import type { Network, Side } from 'shared/domain.js'
import { createExecutionPort } from '../execution/port.js'
import { computeUnrealisedPnl } from '../market-data/pnl.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from '../pipeline.js'
import { KlineSource, type Candle, type KlineInterval, type KlineOracle } from './kline-source.js'

/**
 * Реплей-бэктест (task-4-brief.md): прогоняет накопленный дамп сообщений канала через РЕАЛЬНЫЙ
 * пайплайн (processMessage — тот же парсинг/сайзинг/плечо/гварды/дедуп, что в проде) в
 * ИЗОЛИРОВАННОЙ схеме БД, с историческими ценами Bybit (kline mainnet), и собирает отчёт: сколько
 * сигналов, сколько исполнилось бы, что отсеяли гварды и почему, симулированный PnL.
 *
 * Изоляция (критично — НЕ трогать прод/public): в том же Postgres создаётся временная схема
 * `backtest_run` (фикс. имя, дропается в начале и в конце), в неё гоняются те же миграции
 * (api/db/migrate.ts), туда КОПИРУЮТСЯ нужные строки channels/channel_settings/messages/
 * instruments из public. Все запросы пайплайна идут по search_path=backtest_run — прод-таблицы
 * public остаются нетронутыми (проверяется count'ами до/после).
 *
 * Детерминизм: CH1 (2088626562) — детерминированный адаптер (ch1.adapter.ts, route никогда не
 * 'ai'), поэтому бэктест воспроизводим и бесплатен (живой AI НЕ вызывается). Цены исторические,
 * порядок обработки — по tg_message_id. Два прогона на тех же входах дают идентичный отчёт.
 */

const SCHEMA = 'backtest_run'
const DEFAULT_EQUITY = '1000'
const DEFAULT_MAX_SLIPPAGE_PCT = '0.5'
// PnL-симуляция: горизонт удержания и интервал траектории (см. simulateOutcome).
const DEFAULT_PNL_HORIZON_DAYS = 30
const DEFAULT_PNL_INTERVAL: KlineInterval = '15'

export interface ReplayOptions {
  /** channels.id ИЛИ channels.key канала (CLI передаёт числовой id 2088626562). */
  channelKey: number | string
  from?: Date
  to?: Date
  databaseUrl?: string
  /** Сеть для гейта листинга/инструментов (kline всегда mainnet). Дефолт — BYBIT_NETWORK или 'demo'. */
  network?: Network
  equity?: string
  maxEntrySlippagePct?: string
  /** Инжектируемый источник цен — юнит-тест подменяет моком (без реальной сети). */
  kline?: KlineOracle
  /** Считать симулированный PnL по траектории kline (дефолт true). false — быстрый прогон без цен исходов. */
  simulatePnl?: boolean
  pnlHorizonDays?: number
  pnlInterval?: KlineInterval
  /** Оставить схему backtest_run после прогона (для отладки). Дефолт false — дропаем. */
  keepSchema?: boolean
}

export interface PnlSummary {
  tradesEvaluated: number
  tradesWithOutcome: number
  tradesNoPrice: number
  hitTp: number
  hitSl: number
  markToMarket: number
  wins: number
  losses: number
  breakeven: number
  grossProfit: string
  grossLoss: string
  totalPnl: string
  avgPnlPerTrade: string
  assumptions: string[]
}

export interface BacktestReport {
  channelKey: string
  channelId: number
  network: Network
  from: string | null
  to: string | null
  messages: number
  statusBreakdown: Record<string, number>
  /** Сигналы = попытки входа (исполненные открытия + скипы на стадии входа). */
  signals: number
  /** Вошли бы (открытие -> сделка). */
  executed: number
  deltasExecuted: number
  /** Все skipped-действия по причинам (парсинг + гварды). */
  skipped: Record<string, number>
  /** Входы, заблокированные защитным гвардом на стадии риск/исполнение. */
  entriesGuarded: number
  byGuard: Record<string, number>
  /** Сообщения, которым потребовался бы AI (route='ai'). Для CH1 всегда 0 (детерминированный). */
  aiRequired: number
  simulatedPnl: string | null
  pnl: PnlSummary
  isolation: {
    schema: string
    publicUnchanged: boolean
    before: Record<string, number>
    after: Record<string, number>
  }
  klineStats: { requests: number; cacheHits: number; cachedKeys: number }
  notes: string[]
}

/** Причины skip'а, возникающие на стадии РИСК/ИСПОЛНЕНИЕ входа (гварды), а не при парсинге. */
const HANDLER_GUARD_REASONS = new Set([
  'invalid_sl_side',
  'unsafe_stop',
  'mark_price_unavailable',
  'price_slippage',
  'symbol_busy',
  'mmr_unavailable',
  'below_min_notional',
  'zero_qty',
  'copy_disabled',
  'not_implemented_phase1',
])

/**
 * Kysely к тому же Postgres, но с search_path=<schema> ТОЛЬКО (без public). Полная изоляция:
 * ВСЕ незаквалифицированные таблицы/типы/последовательности И ЛЕДЖЕР МИГРАЦИЙ (kysely_migration)
 * резолвятся в backtest_run — иначе Migrator прочитал бы public.kysely_migration (там все миграции
 * уже применены), решил бы "мигрировать нечего" и не создал бы таблиц в backtest_run, после чего
 * незаквалифицированный INSERT провалился бы в public (порча прода). gen_random_uuid/now() —
 * встроенные (pg_catalog, всегда в пути с PG13+), поэтому public в search_path не нужен; строки
 * из public копируются через ЯВНО заквалифицированный `public.<table>` в источнике SELECT.
 */
export function createSchemaDb(databaseUrl: string, schema: string): Kysely<DB> {
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
}

/**
 * Гоняет ТЕ ЖЕ файлы миграций (apps/api/src/db/migrations — переиспользуются, не копируются) в
 * заданную схему. `migrationTableSchema` КРИТИЧЕН: без него интроспекция Kysely видит
 * public.kysely_migration (не ограничена search_path), считает миграции применёнными и НЕ создаёт
 * таблиц в backtest_run — после чего незаквалифицированный INSERT провалился бы в public.
 * С опцией леджер kysely_migration(_lock) явно квалифицируется схемой backtest_run.
 */
async function migrateSchemaToLatest(db: Kysely<DB>, schema: string): Promise<void> {
  // Путь к тем же файлам миграций api относительно этого модуля (apps/engine/src/backtest/ ->
  // apps/api/src/db/migrations). import.meta.url доступен и под tsx, и под vitest (в отличие от
  // import.meta.resolve, которого нет в vite-SSR).
  const migrationFolder = fileURLToPath(new URL('../../../api/src/db/migrations', import.meta.url))
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs: fsp, path, migrationFolder }),
    migrationTableSchema: schema,
  })
  const { error, results } = await migrator.migrateToLatest()
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`[backtest] миграция "${r.migrationName}" упала`)
  }
  if (error) throw error
}

/** Батчевая вставка (обход лимита 65535 bind-параметров на один INSERT). */
async function insertBatched<T extends keyof DB & string>(
  db: Kysely<DB>,
  table: T,
  rows: ReadonlyArray<Insertable<DB[T]>>,
  batchSize = 800,
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await db
      .insertInto(table)
      .values(rows.slice(i, i + batchSize))
      .execute()
  }
}

const PUBLIC_COUNT_TABLES = ['messages', 'actions', 'trades', 'orders', 'positions', 'executions'] as const

async function countPublic(db: Kysely<DB>): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of PUBLIC_COUNT_TABLES) {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM public.${sql.raw(t)}`.execute(db)
    out[t] = Number(rows[0]?.n ?? 0)
  }
  return out
}

export async function replay(options: ReplayOptions): Promise<BacktestReport> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('replay: DATABASE_URL не задан (передайте options.databaseUrl или задайте env)')

  const network: Network = options.network ?? ((process.env.BYBIT_NETWORK as Network | undefined) ?? 'demo')
  const equity = options.equity ?? DEFAULT_EQUITY
  const maxEntrySlippagePct = options.maxEntrySlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT
  const simulatePnl = options.simulatePnl ?? true
  const kline = options.kline ?? new KlineSource()
  const notes: string[] = []

  const adminDb = createDb(databaseUrl)
  let schemaDb: Kysely<DB> | null = null

  try {
    // --- Резолв канала в public ---
    const channel = await adminDb
      .selectFrom('channels')
      .select(['id', 'key', 'adapter_id'])
      .where((eb) =>
        eb.or([eb('key', '=', String(options.channelKey)), eb('id', '=', Number(options.channelKey) || -1)]),
      )
      .executeTakeFirst()
    if (!channel) throw new Error(`replay: канал ${options.channelKey} не найден в public.channels`)
    const channelId = channel.id

    // --- Снимок прод-счётчиков ДО (для проверки неизменности public) ---
    const before = await countPublic(adminDb)

    // --- (Пере)создание изолированной схемы ---
    await sql`DROP SCHEMA IF EXISTS ${sql.ref(SCHEMA)} CASCADE`.execute(adminDb)
    await sql`CREATE SCHEMA ${sql.ref(SCHEMA)}`.execute(adminDb)

    schemaDb = createSchemaDb(databaseUrl, SCHEMA)
    // Санити: соединение реально смотрит в backtest_run (иначе прод под угрозой) — падаем явно.
    const { rows: sp } = await sql<{ search_path: string }>`SHOW search_path`.execute(schemaDb)
    if (!String(sp[0]?.search_path ?? '').includes(SCHEMA)) {
      throw new Error(`replay: search_path не содержит ${SCHEMA} (${sp[0]?.search_path}) — прерываю ради безопасности public`)
    }

    await migrateSchemaToLatest(schemaDb, SCHEMA)

    // --- Копирование нужных строк public -> backtest_run ---
    // ЧЕРЕЗ Kysely (read из public, write в backtest_run), а НЕ `INSERT ... SELECT * FROM public`:
    // enum-типы в разных схемах — РАЗНЫЕ типы Postgres (public.source_kind != backtest_run.
    // source_kind), поэтому прямой межсхемный SELECT падает по несовпадению типа. Значения enum,
    // прочитанные Kysely как строки, при вставке коерсятся к enum ЦЕЛЕВОЙ схемы. Батчами —
    // messages ~тысячи строк, один INSERT упёрся бы в лимит 65535 bind-параметров.
    const channelRows = await adminDb.selectFrom('channels').selectAll().where('id', '=', channelId).execute()
    await schemaDb.insertInto('channels').values(channelRows).execute()

    const settingsRows = await adminDb.selectFrom('channel_settings').selectAll().where('channel_id', '=', channelId).execute()
    // Бэктест отвечает на вопрос "сколько ИСПОЛНИЛОСЬ БЫ", поэтому copy-trading включается принудительно
    // (в public у канала enabled=false — иначе каждый вход был бы skip 'copy_disabled', отчёт бесполезен).
    await schemaDb.insertInto('channel_settings').values(settingsRows.map((s) => ({ ...s, enabled: true }))).execute()
    notes.push('channel_settings.enabled принудительно = true в изолированной схеме (в public канал off).')

    const instrumentRows = await adminDb.selectFrom('instruments').selectAll().where('network', '=', network).execute()
    await insertBatched(schemaDb, 'instruments', instrumentRows)

    // Все сообщения канала (нужны как reply-контекст), со сбросом производных полей и статуса.
    // raw (jsonb) прочитан как объект — при вставке возвращаем строкой (Kysely не сериализует объект в jsonb сам).
    const messageRows = await adminDb.selectFrom('messages').selectAll().where('channel_id', '=', channelId).execute()
    const preparedMessages = messageRows.map((m) => ({
      ...m,
      raw: m.raw === null ? null : JSON.stringify(m.raw),
      status: 'received',
      normalized_text: null,
      status_reason: null,
      method: null,
      ai_summary: null,
    }))
    await insertBatched(schemaDb, 'messages', preparedMessages)

    // --- Выбор сообщений для обработки (окно from/to; порядок — по tg_message_id) ---
    let query = schemaDb.selectFrom('messages').selectAll().where('channel_id', '=', channelId)
    if (options.from) query = query.where('msg_ts', '>=', options.from)
    if (options.to) query = query.where('msg_ts', '<=', options.to)
    const rows = await query.orderBy('tg_message_id', 'asc').execute()

    const dryRun = createExecutionPort('dry_run')
    let processed = 0
    let errors = 0
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
      // getMarkPrice замкнут на ВРЕМЯ ЭТОГО сообщения: гейт staleness/slippage (live-поведение
      // mainnet) сверяет сигнальную цену с исторической ценой Bybit на момент публикации сигнала.
      const tMs = row.msg_ts.getTime()
      const deps: PipelineDeps = {
        executionPort: dryRun,
        network,
        equity,
        getMarkPrice: (symbol: string) => kline.klineAt(symbol, tMs),
        maxEntrySlippagePct,
      }
      try {
        await processMessage(schemaDb, message, deps)
        processed++
      } catch (err) {
        errors++
        console.error(`[backtest] сбой обработки msg tg=${row.tg_message_id}: ${(err as Error).message}`)
      }
    }
    if (errors > 0) notes.push(`Ошибок обработки сообщений: ${errors} (пропущены, не прерывают прогон).`)

    // --- Метрики ---
    const report = await buildMetrics(schemaDb, {
      channelKey: String(channel.key),
      channelId,
      network,
      messagesProcessed: processed,
    })

    // --- Симуляция PnL по траектории kline ---
    const pnl = simulatePnl
      ? await simulatePnlForTrades(schemaDb, channelId, kline, {
          horizonDays: options.pnlHorizonDays ?? DEFAULT_PNL_HORIZON_DAYS,
          interval: options.pnlInterval ?? DEFAULT_PNL_INTERVAL,
        })
      : emptyPnl('PnL-симуляция отключена (simulatePnl=false).')
    report.pnl = pnl
    report.simulatedPnl = pnl.tradesWithOutcome > 0 ? pnl.totalPnl : null
    if (pnl.tradesWithOutcome === 0 && simulatePnl) {
      notes.push('simulatedPnl=null: ни по одной сделке не удалось получить траекторию цен (нет kline).')
    }

    // --- from/to по реально обработанным сообщениям ---
    const range = await schemaDb
      .selectFrom('messages')
      .select(({ fn }) => [fn.min('msg_ts').as('from'), fn.max('msg_ts').as('to')])
      .where('channel_id', '=', channelId)
      .where('status', '<>', 'received')
      .executeTakeFirst()
    report.from = range?.from ? new Date(range.from as unknown as string).toISOString() : null
    report.to = range?.to ? new Date(range.to as unknown as string).toISOString() : null

    // --- Проверка неизменности public ---
    const after = await countPublic(adminDb)
    const publicUnchanged = PUBLIC_COUNT_TABLES.every((t) => before[t] === after[t])
    report.isolation = { schema: SCHEMA, publicUnchanged, before, after }
    if (!publicUnchanged) notes.push('ВНИМАНИЕ: прод-счётчики public ИЗМЕНИЛИСЬ — изоляция нарушена!')

    // Важная оговорка интерпретации: dry-run пайплайн (как и прод в dry_run) НЕ реконсилит филлы
    // TP/SL в закрытие позиции — символ остаётся "занятым" после первого входа до ЯВНОЙ дельты
    // close_remainder. Поэтому symbol_busy (повторный вход по занятому символу) и no_open_position
    // (дельта без открытой позиции) ЗАВЫШЕНЫ: в live с реальными филлами позиции закрывались бы по
    // TP/SL, освобождая символ — часть этих входов реально исполнилась бы. 'executed' — нижняя оценка.
    if ((report.byGuard['symbol_busy'] ?? 0) > 0 || (report.skipped['no_open_position'] ?? 0) > 0) {
      notes.push(
        'symbol_busy/no_open_position ЗАВЫШЕНЫ: dry-run не реконсилит филлы TP/SL в закрытие позиции ' +
          '(символ занят до явной close-дельты). В live позиции закрывались бы по TP/SL — executed=нижняя оценка.',
      )
    }

    report.klineStats = kline.stats
    report.notes.push(...notes)
    return report
  } finally {
    if (schemaDb) await schemaDb.destroy()
    if (!options.keepSchema) {
      await sql`DROP SCHEMA IF EXISTS ${sql.ref(SCHEMA)} CASCADE`.execute(adminDb).catch((err) => {
        console.error(`[backtest] не удалось дропнуть схему ${SCHEMA}: ${(err as Error).message}`)
      })
    }
    await adminDb.destroy()
  }
}

// ---------------------------------------------------------------------------
// Метрики из изолированной схемы
// ---------------------------------------------------------------------------

async function buildMetrics(
  db: Kysely<DB>,
  base: { channelKey: string; channelId: number; network: Network; messagesProcessed: number },
): Promise<BacktestReport> {
  const { channelId } = base

  const statusRows = await db
    .selectFrom('messages')
    .select(({ fn }) => ['status', fn.countAll<string>().as('n')])
    .where('channel_id', '=', channelId)
    .where('status', '<>', 'received')
    .groupBy('status')
    .execute()
  const statusBreakdown: Record<string, number> = {}
  for (const r of statusRows) statusBreakdown[r.status] = Number(r.n)

  // Все skipped-действия по причинам.
  const skipRows = await db
    .selectFrom('actions')
    .select(({ fn }) => ['skip_reason', fn.countAll<string>().as('n')])
    .where('channel_id', '=', channelId)
    .where('status', '=', 'skipped')
    .groupBy('skip_reason')
    .execute()
  const skipped: Record<string, number> = {}
  for (const r of skipRows) skipped[r.skip_reason ?? 'unknown'] = Number(r.n)

  // Входы, дошедшие до риск-хендлера и заблокированные гвардом: type='open', skipped, params<>'{}'
  // (params непуст => сигнал полностью распарсился в intent и упёрся в риск/исполнение, а не в
  // парсинг — ensureWholeMessageAction для парсинг-скипов оставляет params = '{}').
  const guardRows = await sql<{ skip_reason: string | null; n: string }>`
    SELECT skip_reason, count(*)::text AS n FROM actions
    WHERE channel_id = ${channelId} AND type = 'open' AND status = 'skipped' AND params <> '{}'::jsonb
    GROUP BY skip_reason
  `.execute(db)
  const byGuard: Record<string, number> = {}
  let entriesGuarded = 0
  for (const r of guardRows.rows) {
    const reason = r.skip_reason ?? 'unknown'
    byGuard[reason] = Number(r.n)
    entriesGuarded += Number(r.n)
  }

  const executed = Number(
    (
      await db
        .selectFrom('actions')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('channel_id', '=', channelId)
        .where('type', '=', 'open')
        .where('status', '=', 'executed')
        .executeTakeFirstOrThrow()
    ).n,
  )

  const deltasExecuted = Number(
    (
      await db
        .selectFrom('actions')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('channel_id', '=', channelId)
        .where('type', '<>', 'open')
        .where('status', '=', 'executed')
        .executeTakeFirstOrThrow()
    ).n,
  )

  // Сигналы (попытки входа) = исполненные открытия + все type='open' skipped (парсинг+гварды).
  const openSkipped = Number(
    (
      await db
        .selectFrom('actions')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('channel_id', '=', channelId)
        .where('type', '=', 'open')
        .where('status', '=', 'skipped')
        .executeTakeFirstOrThrow()
    ).n,
  )
  const signals = executed + openSkipped

  // route='ai' в parse_results — сообщения, потребовавшие бы AI. Для CH1 всегда 0.
  const aiRequired = Number(
    (
      await sql<{ n: string }>`
        SELECT count(DISTINCT pr.message_id)::text AS n FROM parse_results pr
        JOIN messages m ON m.id = pr.message_id
        WHERE m.channel_id = ${channelId} AND pr.route = 'ai'
      `.execute(db)
    ).rows[0]?.n ?? 0,
  )

  return {
    channelKey: base.channelKey,
    channelId,
    network: base.network,
    from: null,
    to: null,
    messages: base.messagesProcessed,
    statusBreakdown,
    signals,
    executed,
    deltasExecuted,
    skipped,
    entriesGuarded,
    byGuard,
    aiRequired,
    simulatedPnl: null,
    pnl: emptyPnl(''),
    isolation: { schema: SCHEMA, publicUnchanged: true, before: {}, after: {} },
    klineStats: { requests: 0, cacheHits: 0, cachedKeys: 0 },
    notes: [],
  }
}

// ---------------------------------------------------------------------------
// Симуляция исхода по траектории 1m/15m свечей (task-4-brief.md §5)
// ---------------------------------------------------------------------------

export interface SimInput {
  side: Side
  entry: string
  totalQty: string
  sl: string | null
  tps: Array<{ price: string; qty: string }>
  candles: Candle[]
}

export interface SimResult {
  pnl: string
  exit: 'tp' | 'sl' | 'mtm' | 'none'
  filledQty: string
  lastPrice: string | null
}

/**
 * Прогоняет вход по траектории свечей и считает исход механической стратегии "вход + SL + TP-лесенка
 * как выставлено на входе". Внутрисвечная неоднозначность (в одной свече задет и SL, и TP)
 * разрешается КОНСЕРВАТИВНО в пользу SL (worst-case) — исход не завышается. Остаток, не закрытый
 * к концу горизонта, закрывается mark-to-market по close последней свечи. Комиссии/фандинг и
 * ручной менеджмент дельтами (перевод в б/у, ручное закрытие) НЕ моделируются — см. assumptions.
 */
export function simulateOutcome(input: SimInput): SimResult {
  const { side, candles } = input
  const entry = new Decimal(input.entry)
  const sl = input.sl !== null ? new Decimal(input.sl) : null
  let remaining = new Decimal(input.totalQty)
  let realized = new Decimal(0)
  let filled = new Decimal(0)

  // TP только в направлении прибыли, ближайшие к входу — первыми (лесенка срабатывает по ходу цены).
  const tpQueue = input.tps
    .map((t) => ({ price: new Decimal(t.price), qty: new Decimal(t.qty) }))
    .filter((t) => (side === 'long' ? t.price.gt(entry) : t.price.lt(entry)))
    .sort((a, b) => (side === 'long' ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)))

  let exit: SimResult['exit'] = 'none'
  let lastPrice: string | null = null

  for (const candle of candles) {
    lastPrice = candle.close
    const high = new Decimal(candle.high)
    const low = new Decimal(candle.low)

    const slHit = sl !== null && (side === 'long' ? low.lte(sl) : high.gte(sl))
    if (slHit && remaining.gt(0)) {
      realized = realized.plus(computeUnrealisedPnl(side, remaining, entry, sl as Decimal))
      filled = filled.plus(remaining)
      remaining = new Decimal(0)
      exit = 'sl'
      break
    }

    while (tpQueue.length > 0 && remaining.gt(0)) {
      const tp = tpQueue[0]!
      const touched = side === 'long' ? high.gte(tp.price) : low.lte(tp.price)
      if (!touched) break
      const q = Decimal.min(tp.qty, remaining)
      realized = realized.plus(computeUnrealisedPnl(side, q, entry, tp.price))
      filled = filled.plus(q)
      remaining = remaining.minus(q)
      tpQueue.shift()
    }
    if (remaining.lte(0)) {
      exit = 'tp'
      break
    }
  }

  if (exit === 'none' && remaining.gt(0) && lastPrice !== null) {
    realized = realized.plus(computeUnrealisedPnl(side, remaining, entry, new Decimal(lastPrice)))
    filled = filled.plus(remaining)
    remaining = new Decimal(0)
    exit = 'mtm'
  }

  return { pnl: realized.toString(), exit, filledQty: filled.toString(), lastPrice }
}

function emptyPnl(note: string): PnlSummary {
  return {
    tradesEvaluated: 0,
    tradesWithOutcome: 0,
    tradesNoPrice: 0,
    hitTp: 0,
    hitSl: 0,
    markToMarket: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    grossProfit: '0',
    grossLoss: '0',
    totalPnl: '0',
    avgPnlPerTrade: '0',
    assumptions: note ? [note] : [],
  }
}

async function simulatePnlForTrades(
  db: Kysely<DB>,
  channelId: number,
  kline: KlineOracle,
  opts: { horizonDays: number; interval: KlineInterval },
): Promise<PnlSummary> {
  const horizonMs = opts.horizonDays * 86_400_000
  const nowMs = Date.now()

  const trades = await db
    .selectFrom('trades')
    .innerJoin('messages', 'messages.id', 'trades.opened_msg_id')
    .select(['trades.id as id', 'trades.symbol as symbol', 'trades.side as side', 'trades.avg_entry as avgEntry', 'trades.initial_size as initialSize', 'messages.msg_ts as entryTs'])
    .where('trades.channel_id', '=', channelId)
    .where('trades.avg_entry', 'is not', null)
    .where('trades.status', '<>', 'cancelled')
    .execute()

  const summary = emptyPnl('')
  summary.assumptions = [
    'Механическая стратегия: вход по avg_entry сигнала + SL и TP-лесенка КАК ВЫСТАВЛЕНО на входе.',
    'Ручной менеджмент дельтами (перевод SL в б/у, ручное закрытие) НЕ моделируется.',
    'Внутрисвечная неоднозначность (SL и TP в одной свече) — консервативно в пользу SL.',
    `Горизонт удержания ${opts.horizonDays} дн., интервал траектории ${opts.interval}m; остаток закрывается mark-to-market по close последней свечи.`,
    'PnL гросс: комиссии и фандинг НЕ учтены. Цены — mainnet kline.',
  ]

  let gross = new Decimal(0)
  let profit = new Decimal(0)
  let loss = new Decimal(0)
  summary.tradesEvaluated = trades.length

  for (const t of trades) {
    const orders = await db
      .selectFrom('orders')
      .select(['purpose', 'price', 'qty', 'tp_index'])
      .where('trade_id', '=', t.id)
      .where('purpose', 'in', ['tp', 'sl'])
      .execute()
    const slOrder = orders.find((o) => o.purpose === 'sl')
    const tps = orders
      .filter((o) => o.purpose === 'tp' && o.price !== null && o.qty !== null)
      .sort((a, b) => (a.tp_index ?? 0) - (b.tp_index ?? 0))
      .map((o) => ({ price: o.price as string, qty: o.qty as string }))

    const entryMs = (t.entryTs as Date).getTime()
    const endMs = Math.min(entryMs + horizonMs, nowMs)
    const candles = await kline.getCandles(t.symbol, entryMs, endMs, opts.interval)
    if (candles.length === 0) {
      summary.tradesNoPrice++
      continue
    }

    const res = simulateOutcome({
      side: t.side,
      entry: t.avgEntry as string,
      totalQty: (t.initialSize ?? '0') as string,
      sl: slOrder?.price ?? null,
      tps,
      candles,
    })

    summary.tradesWithOutcome++
    if (res.exit === 'tp') summary.hitTp++
    else if (res.exit === 'sl') summary.hitSl++
    else if (res.exit === 'mtm') summary.markToMarket++

    const p = new Decimal(res.pnl)
    gross = gross.plus(p)
    if (p.gt(0)) {
      summary.wins++
      profit = profit.plus(p)
    } else if (p.lt(0)) {
      summary.losses++
      loss = loss.plus(p)
    } else {
      summary.breakeven++
    }
  }

  summary.totalPnl = gross.toDecimalPlaces(4).toString()
  summary.grossProfit = profit.toDecimalPlaces(4).toString()
  summary.grossLoss = loss.toDecimalPlaces(4).toString()
  summary.avgPnlPerTrade =
    summary.tradesWithOutcome > 0 ? gross.div(summary.tradesWithOutcome).toDecimalPlaces(4).toString() : '0'
  return summary
}

// ---------------------------------------------------------------------------
// Форматирование отчёта для CLI
// ---------------------------------------------------------------------------

function table(title: string, entries: Array<[string, string | number]>): string {
  const lines = [`  ${title}`]
  const width = Math.max(0, ...entries.map(([k]) => k.length))
  for (const [k, v] of entries) lines.push(`    ${k.padEnd(width)}  ${v}`)
  return lines.join('\n')
}

function sortedRecord(rec: Record<string, number>): Array<[string, number]> {
  return Object.entries(rec).sort((a, b) => b[1] - a[1])
}

export function formatReport(r: BacktestReport): string {
  const winRate =
    r.pnl.wins + r.pnl.losses > 0
      ? `${((r.pnl.wins / (r.pnl.wins + r.pnl.losses)) * 100).toFixed(1)}%`
      : 'n/a'
  const parts: string[] = []
  parts.push('='.repeat(72))
  parts.push(`  РЕПЛЕЙ-БЭКТЕСТ  канал ${r.channelKey} (id ${r.channelId})  сеть=${r.network}`)
  parts.push('='.repeat(72))
  parts.push(
    table('Период / объём', [
      ['from', r.from ?? '—'],
      ['to', r.to ?? '—'],
      ['сообщений обработано', r.messages],
      ['сигналов (попыток входа)', r.signals],
      ['вошли бы (executed)', r.executed],
      ['дельт исполнено', r.deltasExecuted],
      ['входов заблокировано гвардами', r.entriesGuarded],
      ['требовали бы AI (route=ai)', r.aiRequired],
    ]),
  )
  parts.push(table('Статусы сообщений', sortedRecord(r.statusBreakdown).map(([k, v]) => [k, v])))
  parts.push(table('Skipped по причинам (все действия)', sortedRecord(r.skipped).map(([k, v]) => [k, v])))
  parts.push(
    table(
      'Гварды входа (byGuard)',
      Object.keys(r.byGuard).length ? sortedRecord(r.byGuard).map(([k, v]) => [k, v]) : [['—', 0]],
    ),
  )
  parts.push(
    table('Симулированный PnL', [
      ['simulatedPnl (USDT, гросс)', r.simulatedPnl ?? 'null'],
      ['сделок оценено', r.pnl.tradesEvaluated],
      ['с траекторией цен', r.pnl.tradesWithOutcome],
      ['без цены (нет kline)', r.pnl.tradesNoPrice],
      ['исход TP / SL / MTM', `${r.pnl.hitTp} / ${r.pnl.hitSl} / ${r.pnl.markToMarket}`],
      ['wins / losses / be', `${r.pnl.wins} / ${r.pnl.losses} / ${r.pnl.breakeven}`],
      ['win-rate', winRate],
      ['gross profit / loss', `${r.pnl.grossProfit} / ${r.pnl.grossLoss}`],
      ['avg PnL / сделку', r.pnl.avgPnlPerTrade],
    ]),
  )
  parts.push(
    table('Изоляция БД', [
      ['схема', r.isolation.schema],
      ['public не изменён', r.isolation.publicUnchanged ? 'да' : 'НЕТ (!)'],
      ['public messages до/после', `${r.isolation.before.messages}/${r.isolation.after.messages}`],
      ['public actions до/после', `${r.isolation.before.actions}/${r.isolation.after.actions}`],
      ['public trades до/после', `${r.isolation.before.trades}/${r.isolation.after.trades}`],
    ]),
  )
  parts.push(
    table('kline', [
      ['HTTP-запросов', r.klineStats.requests],
      ['попаданий в кэш', r.klineStats.cacheHits],
      ['ключей в кэше', r.klineStats.cachedKeys],
    ]),
  )
  if (r.pnl.assumptions.length) {
    parts.push('  Допущения PnL:')
    for (const a of r.pnl.assumptions) parts.push(`    - ${a}`)
  }
  if (r.notes.length) {
    parts.push('  Заметки:')
    for (const n of r.notes) parts.push(`    - ${n}`)
  }
  parts.push('='.repeat(72))
  return parts.join('\n')
}
