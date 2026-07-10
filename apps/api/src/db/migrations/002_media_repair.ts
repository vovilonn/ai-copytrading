import { Kysely, sql } from 'kysely'

// Задача 12b: ремонтный проход медиа (docs/superpowers/research/telegram-ingestion.md,
// .superpowers/sdd/task-12b-report.md).
//
// message_media не имел уникального ограничения на (message_id, order_index) — дедуп
// в repository.ts делался вручную (SELECT перед INSERT), что не гарантирует идемпотентность
// под конкурентным вызовом (ремонтный проход и live-поток могут попытаться вставить одну и
// ту же строку одновременно). Ограничение делает ON CONFLICT DO NOTHING настоящей защитой
// на уровне БД, а не только приложения.
//
// messages.media_repair_attempts/media_repair_failed_at — ремонтный проход находит кандидатов
// как `has_media = true AND нет строки message_media`. Без счётчика попыток сообщение с
// объективно недоступным медиа (удалено в Telegram, файл истёк) крутилось бы в ремонте вечно
// каждые 10 минут. failed_at проставляется после исчерпания попыток и исключает такие строки
// из будущих сканирований.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE messages ADD COLUMN media_repair_attempts INT NOT NULL DEFAULT 0`.execute(db)
  await sql`ALTER TABLE messages ADD COLUMN media_repair_failed_at TIMESTAMPTZ`.execute(db)

  await sql`
    ALTER TABLE message_media
      ADD CONSTRAINT uq_media_message_order UNIQUE (message_id, order_index)
  `.execute(db)

  // Ускоряет сканирование кандидатов ремонта (WHERE has_media AND media_repair_failed_at IS NULL).
  await sql`
    CREATE INDEX idx_msg_media_repair ON messages (received_at)
      WHERE has_media AND media_repair_failed_at IS NULL
  `.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_msg_media_repair`.execute(db)
  await sql`ALTER TABLE message_media DROP CONSTRAINT IF EXISTS uq_media_message_order`.execute(db)
  await sql`ALTER TABLE messages DROP COLUMN IF EXISTS media_repair_failed_at`.execute(db)
  await sql`ALTER TABLE messages DROP COLUMN IF EXISTS media_repair_attempts`.execute(db)
}
