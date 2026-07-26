// Разовая чистка торгового журнала: снести все действия/сделки/ордера и объявить уже подтянутые
// сообщения историей.
//
// ЗАЧЕМ. Инцидент прода 25.07.2026: на новом сервере каналы засидились с курсором 0, бэкфилл
// вытянул всю историю (~3100 сообщений), и движок разобрал её как свежие сигналы — 607 действий,
// 2268 вызовов AI на $22.73 и одна РЕАЛЬНАЯ позиция на mainnet по сообщению от 30 декабря 2025.
// Записи такого прогона бессмысленны: они описывают решения по ценам полугодовой давности.
//
// Сообщения НЕ удаляются — они нужны оператору и бэктесту. Им проставляется терминальный статус
// `archived` («вне окна обработки, разбор сознательно не запускался», миграция 004), а каналу —
// водяной знак `process_from_message_id`, после которого движок к этой истории не вернётся
// (pipeline.ts). Записи `ai_calls` тоже остаются: потраченные деньги — факт, который стирать
// нельзя.
//
// ОПАСНО. Функция удаляет журнал ЦЕЛИКОМ, а не по одному каналу. Поэтому она отказывается
// работать, пока в журнале есть живая позиция или незакрытая сделка: снести их локальный след,
// оставив позицию на бирже, — верный способ потерять деньги (движок перестанет её видеть).

import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'

export interface ResetJournalSummary {
  actions: number
  trades: number
  orders: number
  executions: number
  positions: number
  parseResults: number
  /** Сообщений переведено в `archived`. */
  archivedMessages: number
  /** Водяные знаки каналов после чистки: id канала → последнее историческое сообщение. */
  watermarks: Array<{ channelId: number; processFromMessageId: number }>
}

export interface ResetJournalGuard {
  allowed: boolean
  reason?: string
}

/**
 * Отказ, если есть незакрытая сделка или ненулевая позиция: локальный журнал — единственное, чем
 * движок «держит» позицию на бирже (зеркало, владение символом, защитные ордера). Снести его при
 * живой позиции значит оставить её без управления.
 */
export async function checkResetGuard(db: Kysely<DB>): Promise<ResetJournalGuard> {
  const openTrades = await db
    .selectFrom('trades')
    .select(({ fn }) => fn.countAll<string>().as('n'))
    .where('status', 'in', ['open', 'partially_closed'])
    .executeTakeFirstOrThrow()
  if (Number(openTrades.n) > 0) {
    return { allowed: false, reason: `в журнале ${openTrades.n} незакрытых сделок — сначала закройте их` }
  }

  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM positions WHERE size <> 0`.execute(db)
  if (Number(rows[0]?.n ?? 0) > 0) {
    return { allowed: false, reason: `в зеркале ${rows[0]?.n} ненулевых позиций — сначала закройте их на бирже` }
  }

  return { allowed: true }
}

/** Что будет удалено — для печати перед подтверждением (ничего не меняет). */
export async function previewResetJournal(db: Kysely<DB>): Promise<Omit<ResetJournalSummary, 'watermarks'>> {
  const count = async (table: 'actions' | 'trades' | 'orders' | 'executions' | 'positions' | 'parse_results'): Promise<number> => {
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(db)
    return Number(rows[0]?.n ?? 0)
  }
  const { rows: archivable } = await sql<{ n: string }>`
    SELECT count(*)::text AS n
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
     WHERE m.tg_message_id <= c.process_from_message_id AND m.status <> 'archived'
  `.execute(db)

  return {
    actions: await count('actions'),
    trades: await count('trades'),
    orders: await count('orders'),
    executions: await count('executions'),
    positions: await count('positions'),
    parseResults: await count('parse_results'),
    archivedMessages: Number(archivable[0]?.n ?? 0),
  }
}

/**
 * Чистит журнал одной транзакцией. Порядок продиктован внешними ключами и одной циклической
 * связью: `actions.trade_id → trades.id` и `trades.opened_action_id → actions.id` — поэтому
 * ссылки сделки сначала обнуляются, и только потом удаляются строки (тот же рецепт, что и
 * `purgeChannel` в apps/e2e/src/db.ts).
 *
 * `orders.action_id` — NOT NULL: ордера обнулить нельзя, только удалить.
 */
export async function resetJournal(db: Kysely<DB>): Promise<ResetJournalSummary> {
  return db.transaction().execute(async (trx) => {
    const executions = await trx.deleteFrom('executions').executeTakeFirst()
    const orders = await trx.deleteFrom('orders').executeTakeFirst()
    await trx.deleteFrom('trade_legs').execute()
    await trx.deleteFrom('symbol_ownership').execute()
    const positions = await trx.deleteFrom('positions').executeTakeFirst()

    await trx.updateTable('trades').set({ opened_action_id: null, opened_msg_id: null }).execute()
    const actions = await trx.deleteFrom('actions').executeTakeFirst()
    const trades = await trx.deleteFrom('trades').executeTakeFirst()

    // Разбор этих сообщений признан недействительным вместе с действиями — иначе у сообщения в
    // статусе `archived` («не разбирали») остался бы результат разбора.
    const parseResults = await trx.deleteFrom('parse_results').executeTakeFirst()

    // Водяной знак каждого канала — последнее подтянутое сообщение: всё, что уже в БД, история.
    await sql`
      UPDATE channels c
         SET process_from_message_id = GREATEST(
               c.process_from_message_id,
               COALESCE((SELECT MAX(m.tg_message_id) FROM messages m WHERE m.channel_id = c.id), 0)
             ),
             updated_at = now()
    `.execute(trx)

    const archived = await sql<{ n: string }>`
      WITH updated AS (
        UPDATE messages m
           SET status = 'archived', status_reason = 'historical_backlog', updated_at = now()
          FROM channels c
         WHERE c.id = m.channel_id
           AND m.tg_message_id <= c.process_from_message_id
           AND m.status <> 'archived'
        RETURNING 1
      )
      SELECT count(*)::text AS n FROM updated
    `.execute(trx)

    const watermarkRows = await trx.selectFrom('channels').select(['id', 'process_from_message_id']).orderBy('ord').execute()

    return {
      actions: Number(actions.numDeletedRows ?? 0),
      trades: Number(trades.numDeletedRows ?? 0),
      orders: Number(orders.numDeletedRows ?? 0),
      executions: Number(executions.numDeletedRows ?? 0),
      positions: Number(positions.numDeletedRows ?? 0),
      parseResults: Number(parseResults.numDeletedRows ?? 0),
      archivedMessages: Number(archived.rows[0]?.n ?? 0),
      watermarks: watermarkRows.map((row) => ({
        channelId: row.id,
        processFromMessageId: Number(row.process_from_message_id),
      })),
    }
  })
}
