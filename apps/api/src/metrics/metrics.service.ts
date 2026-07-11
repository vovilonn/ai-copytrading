import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { formatDecimal, formatWinRate } from 'shared/numbers.js'
import type { AiMetricsDto, AiModelMetricsDto, ActionsMetricsDto, MetricsDto, TradesMetricsDto } from 'shared/dto.js'
import { DatabaseService } from '../db/database.service.js'

// ai_calls НЕ типизирована в Kysely DB (apps/api/src/db/database.ts:314 — "созданы миграцией, но
// не типизированы, тесты используют sql`...`") — читаем сырым sql, тот же приём, что и
// ChannelStatsService для trades (apps/api/src/channels/stats.service.ts).
// pg.types.setTypeParser(INT8, Number) зарегистрирован глобально в database.ts — count(*)/sum(int)
// приходят JS-числом без ::text/Number(). cost_usd — NUMERIC(12,6), НЕ переопределён — приходит
// строкой (и остаётся строкой в DTO намеренно, деньги — строки).
interface AiModelRow {
  model: string
  calls: number
  cache_hits: number
  escalations: number
  avg_latency_ms: number | null
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  total_cost_usd: string | null
  input_tokens: number | null
  cache_read_tokens: number | null
  output_tokens: number | null
}

interface AiTotalsRow {
  total_calls: number
  cache_hits: number
  errors: number
  total_cost_usd: string | null
}

interface ActionsTotalsRow {
  total: number
  executed: number
  skipped: number
}

interface SkipReasonRow {
  skip_reason: string
  n: number
}

interface TradesRow {
  open: number
  closed: number
  cancelled: number
  decided: number
  wins: number
}

/** Доля [0..1], округлённая до 4 знаков (0.7342) — 0, если знаменатель 0 (данных ещё нет).
 *  Округление только чтобы не тащить в JSON шум плавающей точки (напр. 0.7333333333333333). */
function ratio(num: number, den: number): number {
  if (den <= 0) return 0
  return Math.round((num / den) * 10_000) / 10_000
}

@Injectable()
export class MetricsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** GET /api/metrics/ai (p4-task5-brief.md) — единственный эндпоинт наблюдаемости AI-слоя и
   *  движка: вызовы модели (стоимость/кэш/латентность/эскалации) + действия (исполнено/пропущено). */
  async getMetrics(): Promise<MetricsDto> {
    const [ai, actions, trades] = await Promise.all([
      this.getAiMetrics(),
      this.getActionsMetrics(),
      this.getTradesMetrics(),
    ])
    return { ai, actions, trades }
  }

  private async getAiMetrics(): Promise<AiMetricsDto> {
    const [{ rows: modelRows }, { rows: totalsRows }] = await Promise.all([
      sql<AiModelRow>`
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
      `.execute(this.database.db),
      sql<AiTotalsRow>`
        SELECT
          count(*) AS total_calls,
          count(*) FILTER (WHERE cache_hit) AS cache_hits,
          count(*) FILTER (WHERE error IS NOT NULL) AS errors,
          sum(cost_usd) AS total_cost_usd
        FROM ai_calls
      `.execute(this.database.db),
    ])

    const byModel: AiModelMetricsDto[] = modelRows.map((row) => ({
      model: row.model,
      calls: row.calls,
      cacheHitRate: ratio(row.cache_hits, row.calls),
      escalations: row.escalations,
      avgLatencyMs: row.avg_latency_ms ?? 0,
      p50LatencyMs: row.p50_latency_ms ?? 0,
      p95LatencyMs: row.p95_latency_ms ?? 0,
      totalCostUsd: `$${formatDecimal(row.total_cost_usd ?? '0')}`,
      inputTokens: row.input_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
    }))

    const totals = totalsRows[0]
    return {
      totalCalls: totals?.total_calls ?? 0,
      byModel,
      totalCostUsd: `$${formatDecimal(totals?.total_cost_usd ?? '0')}`,
      cacheHitRate: ratio(totals?.cache_hits ?? 0, totals?.total_calls ?? 0),
      errors: totals?.errors ?? 0,
    }
  }

  private async getActionsMetrics(): Promise<ActionsMetricsDto> {
    const [{ rows: totalsRows }, { rows: reasonRows }] = await Promise.all([
      sql<ActionsTotalsRow>`
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE status = 'executed') AS executed,
          count(*) FILTER (WHERE skip_reason IS NOT NULL) AS skipped
        FROM actions
      `.execute(this.database.db),
      // skip_reason IS NOT NULL — а не status = 'skipped': needs_review-строки (ai_unavailable,
      // symbol_unknown_needs_vision и т.п.) тоже несут причину и операторски это ровно то же
      // "AI-слой не исполнил действие, вот почему" (см. фикстуру metrics.e2e.test.ts).
      sql<SkipReasonRow>`
        SELECT skip_reason, count(*) AS n
        FROM actions
        WHERE skip_reason IS NOT NULL
        GROUP BY skip_reason
        ORDER BY skip_reason
      `.execute(this.database.db),
    ])

    const totals = totalsRows[0]
    const bySkipReason: Record<string, number> = {}
    for (const row of reasonRows) bySkipReason[row.skip_reason] = row.n

    return {
      total: totals?.total ?? 0,
      executed: totals?.executed ?? 0,
      skipped: totals?.skipped ?? 0,
      bySkipReason,
    }
  }

  /** Win Rate по ВСЕМ каналам сразу (без фильтра channel_id) — та же формула/хелпер
   *  (formatWinRate), что и ChannelStatsService.winRateFor, переиспользованная не через сервис
   *  (тот скоупит по одному каналу), а напрямую: разница только в отсутствии WHERE channel_id.
   *  Знаменатель winRate — `decided` (closed AND is_win IS NOT NULL), а не `closed` (адверсариал-
   *  ревью I1): dry-run-закрытия с is_win=NULL исключаются, иначе winRate завышенно показывал бы
   *  «0%» — расходясь с колонкой Win Rate в списке каналов (stats.service.ts). `closed` остаётся
   *  в ответе как отдельная метрика (сколько всего закрыто). */
  private async getTradesMetrics(): Promise<TradesMetricsDto> {
    const { rows } = await sql<TradesRow>`
      SELECT
        count(*) FILTER (WHERE status = 'open') AS open,
        count(*) FILTER (WHERE status = 'closed') AS closed,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE status = 'closed' AND is_win IS NOT NULL) AS decided,
        count(*) FILTER (WHERE status = 'closed' AND is_win) AS wins
      FROM trades
    `.execute(this.database.db)
    const row = rows[0]
    return {
      open: row?.open ?? 0,
      closed: row?.closed ?? 0,
      cancelled: row?.cancelled ?? 0,
      winRate: formatWinRate(row?.decided ?? 0, row?.wins ?? 0),
    }
  }
}
