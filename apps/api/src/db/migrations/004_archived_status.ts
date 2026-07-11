import { Kysely, sql } from 'kysely'

// Задача p2-forum300 (.superpowers/sdd/p2-forum300-report.md): защита от неконтролируемого
// прогона исторического бэклога форума `1962583820` (tg_message_id < 221146, ~1357 сообщений в
// статусе `received`) при запуске live-поллера engine (apps/engine/src/main.ts::processChannel —
// выбирает строго `WHERE status = 'received'`). Нужен терминальный статус, который этот запрос
// НЕ выбирает.
//
// Среди уже существующих терминальных статусов ни один не подошёл:
// - executed/skipped/needs_review несут ТОРГОВЫЙ смысл (реальный исход исполнения) — навешивать
//   их на сообщения, которые вообще не проходили через adapter.parse()/reconcile(), было бы ложью
//   в данных;
// - noise — тоже занят доменной семантикой: пишется `pipeline.ts` (строки ~130-133) как РЕЗУЛЬТАТ
//   классификации (AI или детерминированный адаптер решили, что сообщение не сигнал). Если тем же
//   значением пометить сообщения, которые мы просто не стали разбирать по политике окна, будущая
//   аналитика ("какая доля сообщений — реальный шум") смешает два разных факта в одной колонке.
//
// Поэтому — отдельное значение enum `archived`: означает ровно "вне окна обработки, разбор
// сознательно не запускался", без претензии на классификацию содержимого.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  // ALTER TYPE ... ADD VALUE безопасен внутри транзакции начиная с PG12 (используемая версия —
  // 16), ПОКА новое значение не используется в той же транзакции — здесь оно только объявляется,
  // не используется никаким UPDATE/WHERE рядом.
  await sql`ALTER TYPE msg_status ADD VALUE IF NOT EXISTS 'archived'`.execute(db)
}

// Postgres не поддерживает DROP VALUE для enum — единственный путь отката: пересоздать тип без
// значения и перевести колонку на него. Возможно, только если ни одна строка сейчас не в статусе
// 'archived' (иначе USING-каст в старый набор значений упадёт) — ожидаемо для отката ДО того, как
// данные были архивированы этим значением, не после.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM messages WHERE status = 'archived'`.execute(db)
  const archivedCount = Number(rows[0]?.n ?? 0)
  if (archivedCount > 0) {
    throw new Error(
      `откат 004_archived_status невозможен: ${archivedCount} сообщение(й) в статусе 'archived' — ` +
        'сначала переведите их в другой статус вручную',
    )
  }
  await sql`ALTER TYPE msg_status RENAME TO msg_status_old`.execute(db)
  await sql`CREATE TYPE msg_status AS ENUM ('received','normalized','parsed','decided',
                                             'executing','executed','skipped','needs_review','noise','failed')`.execute(
    db,
  )
  await sql`ALTER TABLE messages ALTER COLUMN status DROP DEFAULT`.execute(db)
  await sql`ALTER TABLE messages ALTER COLUMN status TYPE msg_status USING status::text::msg_status`.execute(db)
  await sql`ALTER TABLE messages ALTER COLUMN status SET DEFAULT 'received'::msg_status`.execute(db)
  await sql`DROP TYPE msg_status_old`.execute(db)
}
