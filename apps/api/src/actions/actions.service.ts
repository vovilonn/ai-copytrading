import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { ACTION_TYPES, actionIcon, actionIconColor, actionSummary, ACTION_META } from 'shared/action-meta.js'
import type { ActionType, Side } from 'shared/domain.js'
import type { ActionRowDto } from 'shared/dto.js'
import { DatabaseService } from '../db/database.service.js'

/** Query-параметры GET /api/actions (task-8-brief.md) — все опциональны, отсутствие/'all' = без фильтра. */
export interface ActionsFilter {
  channel?: string
  period?: string
  type?: string
  side?: string
  q?: string
}

const SIDES: ReadonlySet<string> = new Set<Side>(['long', 'short'])
const PERIODS: ReadonlySet<string> = new Set(['today', '7d', '30d'])

function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value)
}

/** Ровно 3 значения периода из дизайна (design/project/Admin.dc.html: periodOpts) — 'all' сюда
 *  не попадает (уже отфильтровано вызывающим кодом), сравнение сразу с actions.created_at. */
function periodCondition(period: 'today' | '7d' | '30d') {
  if (period === 'today') return sql<boolean>`a.created_at >= date_trunc('day', now())`
  if (period === '7d') return sql<boolean>`a.created_at >= now() - interval '7 days'`
  return sql<boolean>`a.created_at >= now() - interval '30 days'`
}

@Injectable()
export class ActionsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** GET /api/actions — плоский слой действий (design/project/Admin.dc.html:306-392), свежие
   *  сверху. Джойн с channels — имя/инициал канала, LEFT JOIN с trades — tradeRef (у skipped-
   *  actions trade_id всегда null, поэтому именно LEFT, а не INNER). */
  async listActions(filter: ActionsFilter): Promise<ActionRowDto[]> {
    let query = this.database.db
      .selectFrom('actions as a')
      .innerJoin('channels as c', 'c.id', 'a.channel_id')
      .leftJoin('trades as t', 't.id', 'a.trade_id')
      .select([
        'a.id as id',
        'a.type as type',
        'a.side as side',
        'a.pair as pair',
        'a.pct as pct',
        'a.method as method',
        'a.skip_reason as skip_reason',
        'a.created_at as created_at',
        'a.channel_id as channel_id',
        'c.title as channel_title',
        'c.key as channel_key',
        't.human_ref as human_ref',
      ])

    if (filter.channel && filter.channel !== 'all') {
      const channelId = Number(filter.channel)
      if (Number.isFinite(channelId)) query = query.where('a.channel_id', '=', channelId)
    }
    if (filter.type && filter.type !== 'all' && isActionType(filter.type)) {
      query = query.where('a.type', '=', filter.type)
    }
    if (filter.side && SIDES.has(filter.side)) {
      query = query.where('a.side', '=', filter.side as Side)
    }
    if (filter.q && filter.q.trim()) {
      // Спека брифа: "q (поиск по символу)" — совпадает с design'ом (Search by pair… матчит
      // только act.pair, у нас symbol/pair всегда равны на непропущенных строках, см. pipeline.ts).
      query = query.where('a.symbol', 'ilike', `%${filter.q.trim()}%`)
    }
    if (filter.period && PERIODS.has(filter.period)) {
      query = query.where(periodCondition(filter.period as 'today' | '7d' | '30d'))
    }

    const rows = await query.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').execute()
    return rows.map(
      (row): ActionRowDto => ({
        id: row.id,
        type: row.type,
        side: row.side,
        short: ACTION_META[row.type].short,
        pair: row.pair,
        summary: actionSummary(row.type, row.pct),
        tradeRef: row.human_ref ? `#${row.human_ref}` : null,
        channelId: row.channel_id,
        channelName: row.channel_title ?? row.channel_key,
        channelInitial: (row.channel_title ?? row.channel_key).charAt(0).toUpperCase(),
        time: row.created_at.toISOString(),
        // actions.method хранится строкой (см. apps/api/src/db/database.ts) — Ф1 (CH1) публикует
        // только 'auto', 'review' появится вместе с AI-слоем (Ф2), 'ai' пока недостижим тоже.
        method: row.method === 'ai' ? 'ai' : 'auto',
        skipReason: row.skip_reason,
        icon: actionIcon(row.type, row.side),
        iconColor: actionIconColor(row.type, row.side),
      }),
    )
  }
}
