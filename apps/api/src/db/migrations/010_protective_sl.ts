import { Kysely, sql } from 'kysely'

// ЧЕЙ СТОП СТОИТ НА СДЕЛКЕ — наш защитный или авторский.
//
// ЗАЧЕМ. Автор сплошь и рядом входит без стопа, и тогда бот вешает СВОЙ (политика
// no_sl_policy='attach_protective_sl'): он выводится из плеча и цены входа и стоит строго перед
// ликвидацией. Такой стоп обязан переезжать вслед за средней ценой позиции — иначе после доливки
// НИЖЕ входа он остаётся на уровне, посчитанном от первого входа, и накрывает уже удвоенный объём
// в паре процентов под ценой доливки. Живой случай 29.09.2026 (TR-1120, 1000PEPE): вход 0.00444,
// доливка 0.0041, стоп так и остался 0.004064 — выбило всю позицию на −68.67$.
//
// Авторский стоп двигать НЕЛЬЗЯ: это его решение о риске, а не наша арифметика. Отличить один от
// другого по данным было нечем — отсюда этот флаг.
//
// DEFAULT false ⇒ поведение уже открытых сделок не меняется: пересчёт включится на тех, что
// откроются после деплоя (либо флаг проставит оператор вручную для живой сделки).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS protective_sl BOOLEAN NOT NULL DEFAULT false
  `.execute(db)

  await sql`
    COMMENT ON COLUMN trades.protective_sl IS
      'true — на позиции стоит НАШ защитный стоп (автор своего не давал): пересчитывается от средней цены после каждой доливки'
  `.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE trades DROP COLUMN IF EXISTS protective_sl`.execute(db)
}
