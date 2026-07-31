import { Kysely, sql } from 'kysely'

// Фиксированная сумма сделки в приоритете над риском из сигнала.
//
// ЗАЧЕМ. Размер позиции считается двумя способами (risk/sizing.ts): если автор указал в сообщении
// риск («Риск: 1%»), объём выводится из него и стоп-дистанции; если не указал — берётся
// `trade_size` канала. Первый способ означает, что реальная сумма сделки МЕНЯЕТСЯ от сигнала к
// сигналу (тесный стоп -> крупная позиция) и ограничена только депозитом и плечом. Оператору
// нужен режим «всегда торгуй ровно на мою сумму»: тумблер делает `trade_size` главнее риска.
//
// DEFAULT false — поведение существующих каналов не меняется ни на цент.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE channel_settings
      ADD COLUMN IF NOT EXISTS force_trade_size BOOLEAN NOT NULL DEFAULT false
  `.execute(db)

  await sql`
    COMMENT ON COLUMN channel_settings.force_trade_size IS
      'true — размер сделки всегда берётся из trade_size, даже когда в сигнале указан риск в процентах'
  `.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE channel_settings DROP COLUMN IF EXISTS force_trade_size`.execute(db)
}
