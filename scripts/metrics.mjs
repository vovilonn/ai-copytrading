#!/usr/bin/env node
/**
 * CLI-отчёт по наблюдаемости AI-слоя и движка (Ф4, задача 5) — вызовы модели
 * (стоимость/кэш-хиты/латентность p50/p95/эскалации) + действия (исполнено/пропущено по причинам).
 * Read-only: только SELECT, ничего не пишет в БД. Тот же контракт агрегатов, что и
 * GET /api/metrics/ai (apps/api/src/metrics/metrics.service.ts) — не дублирует формулы вслепую,
 * SQL здесь написан заново намеренно (это отдельный процесс без доступа к NestJS DI/Kysely),
 * но группировки/фильтры идентичны сервису 1:1.
 *
 * 'pg' — зависимость apps/api (workspace), в корне репозитория её нет — резолвим через
 * createRequire от apps/api/package.json (тот же pnpm workspace node_modules), не добавляя pg
 * в корневой package.json (тот же приём, что и spawn-в-workspace у scripts/backtest.mjs, только
 * без отдельного процесса — нам не нужен TypeScript, только сама библиотека).
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const apiRequire = createRequire(join(repoRoot, 'apps', 'api', 'package.json'))
const pg = apiRequire('pg')

// node-postgres по умолчанию отдаёт NUMERIC/int8 строками — тот же аргумент, что и в
// apps/api/src/db/database.ts: наши bigint-счётчики заведомо меньше MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('DATABASE_URL не задан — скопируйте .env.example в .env (POSTGRES_USER/PASSWORD/DB/PORT собираются в DATABASE_URL).')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: databaseUrl })

/** '500.00000000' -> '500' / '0.100000' -> '0.1' — тот же приём, что и formatDecimal
 *  (packages/shared/src/numbers.ts), переписан здесь заново: скрипт запускается плоским `node`
 *  (см. корневой package.json), не может импортировать .ts из workspace-пакета shared. */
function trimDecimal(value) {
  return String(Number(value ?? 0))
}

function money(value) {
  return `$${trimDecimal(value)}`
}

function pct(num, den) {
  if (!den) return '—'
  return `${Math.round((num / den) * 100)}%`
}

/** Простая табличная печать с выравниванием по ширине самой длинной ячейки в колонке. */
function printTable(headers, rows, aligns = []) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) =>
    cells.map((c, i) => (aligns[i] === 'left' ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ')
  console.log(line(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(line(row))
}

async function main() {
  const [byModelRes, totalsRes, actionsTotalsRes, skipReasonsRes, tradesRes] = await Promise.all([
    pool.query(`
      SELECT
        model,
        count(*) AS calls,
        count(*) FILTER (WHERE cache_hit) AS cache_hits,
        count(*) FILTER (WHERE escalated) AS escalations,
        round(avg(latency_ms))::int AS avg_latency_ms,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::int AS p50_latency_ms,
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms,
        sum(cost_usd) AS total_cost_usd,
        sum(input_tokens) AS input_tokens,
        sum(cache_read_input_tokens) AS cache_read_tokens,
        sum(output_tokens) AS output_tokens
      FROM ai_calls
      GROUP BY model
      ORDER BY model
    `),
    pool.query(`
      SELECT
        count(*) AS total_calls,
        count(*) FILTER (WHERE cache_hit) AS cache_hits,
        count(*) FILTER (WHERE error IS NOT NULL) AS errors,
        sum(cost_usd) AS total_cost_usd
      FROM ai_calls
    `),
    pool.query(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE status = 'executed') AS executed,
        count(*) FILTER (WHERE skip_reason IS NOT NULL) AS skipped
      FROM actions
    `),
    pool.query(`
      SELECT skip_reason, count(*) AS n
      FROM actions
      WHERE skip_reason IS NOT NULL
      GROUP BY skip_reason
      ORDER BY n DESC
    `),
    pool.query(`
      SELECT
        count(*) FILTER (WHERE status = 'open') AS open,
        count(*) FILTER (WHERE status = 'closed') AS closed,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE status = 'closed' AND is_win) AS wins
      FROM trades
    `),
  ])

  console.log('\n=== AI: вызовы модели ===\n')
  if (byModelRes.rows.length === 0) {
    console.log('(нет данных — ai_calls пуста)')
  } else {
    printTable(
      ['Model', 'Calls', 'Cache%', 'Escal', 'AvgMs', 'P50Ms', 'P95Ms', 'Cost'],
      byModelRes.rows.map((r) => [
        r.model,
        r.calls,
        pct(r.cache_hits, r.calls),
        r.escalations,
        r.avg_latency_ms ?? '—',
        r.p50_latency_ms ?? '—',
        r.p95_latency_ms ?? '—',
        money(r.total_cost_usd),
      ]),
      ['left'],
    )
  }

  const totals = totalsRes.rows[0] ?? { total_calls: 0, cache_hits: 0, errors: 0, total_cost_usd: '0' }
  console.log(
    `\nИтого: ${totals.total_calls} вызовов, стоимость ${money(totals.total_cost_usd)}, ` +
      `cache-hit ${pct(totals.cache_hits, totals.total_calls)}, ошибок ${totals.errors}`,
  )

  console.log('\n=== Действия движка ===\n')
  const actionsTotals = actionsTotalsRes.rows[0] ?? { total: 0, executed: 0, skipped: 0 }
  console.log(`Всего: ${actionsTotals.total} | Исполнено: ${actionsTotals.executed} | Пропущено (с причиной): ${actionsTotals.skipped}`)

  if (skipReasonsRes.rows.length > 0) {
    console.log('\nПричины пропуска:')
    printTable(
      ['Reason', 'Count'],
      skipReasonsRes.rows.map((r) => [r.skip_reason, r.n]),
      ['left'],
    )
  }

  const trades = tradesRes.rows[0] ?? { open: 0, closed: 0, cancelled: 0, wins: 0 }
  const winRate = trades.closed > 0 ? `${Math.round((trades.wins / trades.closed) * 100)}%` : '—'
  console.log(
    `\n=== Сделки ===\n\nOpen: ${trades.open} | Closed: ${trades.closed} | Cancelled: ${trades.cancelled} | Win Rate: ${winRate}\n`,
  )
}

main()
  .catch((err) => {
    console.error('[metrics] ошибка:', err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
