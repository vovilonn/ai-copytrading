import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { ACTION_TYPES, actionIcon, actionIconColor, actionSummary, ACTION_META } from 'shared/action-meta.js'
import type { ActionType, Side } from 'shared/domain.js'
import type { ActionRowDto } from 'shared/dto.js'
import { DatabaseService } from '../db/database.service.js'
import { escapeLikePattern } from '../db/like-escape.js'

/** Query-параметры GET /api/actions (task-8-brief.md) — все опциональны, отсутствие/'all' = без фильтра. */
export interface ActionsFilter {
  channel?: string
  period?: string
  type?: string
  side?: string
  q?: string
  /** Размер страницы — clamp'ится в [1, MAX_LIMIT], по умолчанию DEFAULT_LIMIT (финальное
   *  ревью Ф1, Important #2: без LIMIT список рос бы вечно). */
  limit?: string
  /** Keyset-курсор пагинации — id ранее полученной строки (ORDER BY created_at DESC, id DESC):
   *  отдаёт строки СТРОГО ПОСЛЕ неё в этом порядке. Устроено как id, а не пара
   *  created_at+id в двух отдельных параметрах — клиенту достаточно запомнить id последней
   *  строки страницы, сам created_at для сравнения сервис подтягивает подзапросом. */
  before?: string
}

const SIDES: ReadonlySet<string> = new Set<Side>(['long', 'short'])
const PERIODS: ReadonlySet<string> = new Set(['today', '7d', '30d'])
// actions.id — UUID (см. миграцию 001_initial.ts) — валидируем формат курсора ПЕРЕД тем, как
// подставить его в `id = $before`: иначе мусорный/сфабрикованный `before` не приводится Postgres
// к uuid и роняет запрос 500-й вместо пустой страницы (тот же защитный принцип, что и у
// Number.isFinite(channelId) выше для `channel`).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

/** Clamp тот же приём, что и у `channel`/`type`/`side` ниже — некорректное/отсутствующее
 *  значение тихо откатывается к дефолту, а не 400-ит запрос. */
function clampLimit(raw: string | undefined): number {
  const n = raw !== undefined ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.trunc(n), MAX_LIMIT)
}

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
      // escapeLikePattern — иначе `%`/`_` в пользовательском вводе работали бы как LIKE-wildcard
      // (Minor #3 финального ревью Ф1), а не как буквальные символы поиска.
      query = query.where('a.symbol', 'ilike', `%${escapeLikePattern(filter.q.trim())}%`)
    }
    if (filter.period && PERIODS.has(filter.period)) {
      query = query.where(periodCondition(filter.period as 'today' | '7d' | '30d'))
    }
    if (filter.before && UUID_RE.test(filter.before.trim())) {
      // Keyset по (created_at, id) — строго "старше" строки-курсора в том же порядке, что и
      // ORDER BY ниже (created_at DESC, id DESC). Ссылаемся на курсор подзапросом по id: если
      // строка с таким id успела исчезнуть, подзапрос вернёт 0 строк, сравнение с NULL даст
      // UNKNOWN — пустая страница, а не крэш (защитно для протухшего курсора).
      const beforeId = filter.before.trim()
      query = query.where(
        sql<boolean>`(a.created_at, a.id) < (SELECT created_at, id FROM actions WHERE id = ${beforeId})`,
      )
    }

    const rows = await query
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(clampLimit(filter.limit))
      .execute()
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
