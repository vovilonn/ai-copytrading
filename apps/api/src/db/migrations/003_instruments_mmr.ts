import { Kysely, sql } from 'kysely'

// Задача 1 (Ф1): кэш инструментов Bybit (instruments-info + risk-limit) нуждается в MMR
// (maintenance margin rate, tier1 из risk-limit) для формулы safe-leverage/liq-price
// (docs/superpowers/research/bybit-execution.md §6). В исходной схеме (001_initial.ts) колонки
// не было — добавляем отдельной миграцией. Nullable: не у каждого символа есть risk-limit тиры
// (напр. делистнутый на конкретной сети инструмент — Bybit отдаёт retCode=10001 на risk-limit).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE instruments ADD COLUMN mmr NUMERIC(10,6)`.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE instruments DROP COLUMN IF EXISTS mmr`.execute(db)
}
