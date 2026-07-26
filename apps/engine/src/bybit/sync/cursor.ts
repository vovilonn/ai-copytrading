// Водяные знаки догона истории: «докуда мы уже прочитали биржу». Хранятся в app_state — таблица
// была заведена ровно под это (001_initial.ts: «курсоры реконсиляции»), но до сих пор пустовала.
//
// КУРСОР = КОНЕЦ ПОЛНОСТЬЮ ПОТРЕБЛЁННОГО ОКНА, а не max(execTime) прочитанных записей. Иначе пустое
// окно (за сутки не было ни одной сделки) не двигало бы курсор, и мы вечно перечитывали бы один и
// тот же интервал.

import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'

export type SyncCursorBase = 'sync:executions' | 'sync:closed_pnl' | 'sync:order_history'
/** Ключ курсора в app_state: базовый для общего аккаунта, с суффиксом `:<fingerprint>` — для
 *  аккаунта конкретного канала (см. runtime/account-registry.ts). */
export type SyncCursorKey = SyncCursorBase | `${SyncCursorBase}:${string}`

/**
 * Курсор ПРИВЯЗАН К АККАУНТУ. Догон истории читает execution/closed-pnl/order-history конкретных
 * кредов — общий водяной знак на несколько аккаунтов означал бы, что первый же успешный проход
 * «съедает» окно за остальных, и их история теряется без единой ошибки.
 *
 * Общий аккаунт из env сохраняет БАЗОВЫЙ ключ без суффикса: иначе после этой задачи он начал бы
 * догонять историю с нуля (bootstrap на 7 дней) на уже работающем проде.
 */
export function cursorKey(base: SyncCursorBase, accountFingerprint?: string): SyncCursorKey {
  return accountFingerprint === undefined ? base : `${base}:${accountFingerprint}`
}

/** Максимальное окно ОДНОГО запроса к Bybit — 7 дней (retCode 10001 при превышении). Берём 6 суток:
 *  запас на дрейф часов и на OVERLAP ниже. */
export const WINDOW_MS = 6 * 24 * 60 * 60 * 1000

/** Нахлёст назад от курсора: биржа может отдать исполнение с задержкой относительно его execTime.
 *  Перечитать лишнее безопасно — вставка идемпотентна (UNIQUE bybit_exec_id). */
export const OVERLAP_MS = 60_000

/** Глубина хранения истории у Bybit — 2 года (дальше retCode 10001 «Can't query order earlier than
 *  2 years»). Даунтайм больше этого срока невосстановим — честно помечаем разрыв, а не выдумываем. */
export const RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000

/** Предохранитель: один проход не должен висеть вечно, остаток догонит следующий тик. */
export const MAX_WINDOWS_PER_RUN = 60

/** Глубина догона при ПЕРВОМ запуске (курсора ещё нет) — решение заказчика: 7 дней. */
export const BOOTSTRAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

export interface CursorValue {
  /** Конец полностью потреблённого окна (мс). */
  windowEndMs: number
  updatedAt: string
}

export async function readCursor(db: Kysely<DB>, key: SyncCursorKey): Promise<number | null> {
  const row = await db.selectFrom('app_state').select('value').where('key', '=', key).executeTakeFirst()
  if (!row) return null
  const value = row.value as Partial<CursorValue> | null
  const ms = Number(value?.windowEndMs)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/**
 * Монотонная запись: курсор не едет назад. Защита от гонки двух проходов (или движка и ручного
 * бэкфилла): более старое окно не затирает более свежее.
 */
export async function writeCursor(db: Kysely<DB>, key: SyncCursorKey, windowEndMs: number): Promise<void> {
  const value: CursorValue = { windowEndMs, updatedAt: new Date().toISOString() }
  await sql`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE (app_state.value->>'windowEndMs')::bigint < (EXCLUDED.value->>'windowEndMs')::bigint
  `.execute(db)
}

export interface SyncWindow {
  start: number
  end: number
}

/**
 * Режет период [from, to] на окна, укладывающиеся в лимит одного запроса Bybit.
 * Окна идут по возрастанию времени — применять историю нужно в хронологическом порядке.
 */
export function chunkWindows(from: number, to: number, windowMs: number = WINDOW_MS): SyncWindow[] {
  const windows: SyncWindow[] = []
  let start = from
  while (start < to && windows.length < MAX_WINDOWS_PER_RUN) {
    const end = Math.min(start + windowMs, to)
    windows.push({ start, end })
    start = end
  }
  return windows
}

export interface ResolvedRange {
  from: number
  /** Догон обрезан ретенцией биржи (даунтайм > 2 лет) — часть истории невосстановима. */
  truncated: boolean
}

/**
 * С какого момента дочитывать. Курсор есть — от него с нахлёстом; нет (первый запуск) — от
 * BOOTSTRAP_LOOKBACK_MS назад, но не позже самой старой ЖИВОЙ сделки журнала (иначе её филлы,
 * случившиеся раньше окна, останутся неучтёнными и PnL будет неполным).
 */
export async function resolveSyncFrom(
  db: Kysely<DB>,
  key: SyncCursorKey,
  nowMs: number,
  oldestLiveTradeMs?: number | null,
): Promise<ResolvedRange> {
  const cursor = await readCursor(db, key)

  let from: number
  if (cursor !== null) {
    from = cursor - OVERLAP_MS
  } else {
    const bootstrap = nowMs - BOOTSTRAP_LOOKBACK_MS
    from = oldestLiveTradeMs != null ? Math.min(bootstrap, oldestLiveTradeMs) : bootstrap
  }

  const earliest = nowMs - RETENTION_MS
  if (from < earliest) {
    return { from: earliest, truncated: true }
  }
  return { from, truncated: false }
}
