import { Kysely, sql } from 'kysely'

// Задача p3-task6-demo: заказчик переключил Bybit-ключи с testnet на DEMO TRADING (testnet блокирует
// order/create regulatory-кодом 10024, demo — торгует). Добавляем 'demo' в enum net_t, иначе
// instruments.network (PRIMARY KEY (symbol, network), 001_initial.ts) не смог бы принять строки
// с network='demo' — InstrumentsService.refresh() на BYBIT_NETWORK=demo падал бы на INSERT.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  // ALTER TYPE ... ADD VALUE безопасен внутри транзакции начиная с PG12 (используемая версия — 16),
  // ПОКА новое значение не используется в той же транзакции — здесь оно только объявляется (тот же
  // приём, что и 004_archived_status.ts).
  await sql`ALTER TYPE net_t ADD VALUE IF NOT EXISTS 'demo'`.execute(db)
}

// Postgres не поддерживает DROP VALUE для enum — единственный путь отката: пересоздать тип без
// значения и перевести колонку instruments.network на него. Возможен только если ни одной строки
// с network='demo' сейчас нет (иначе USING-каст в старый набор значений упадёт).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM instruments WHERE network = 'demo'`.execute(db)
  const demoCount = Number(rows[0]?.n ?? 0)
  if (demoCount > 0) {
    throw new Error(
      `откат 005_demo_network невозможен: ${demoCount} строк(и) instruments с network='demo' — ` +
        'сначала удалите их вручную',
    )
  }
  await sql`ALTER TYPE net_t RENAME TO net_t_old`.execute(db)
  await sql`CREATE TYPE net_t AS ENUM ('testnet','mainnet')`.execute(db)
  await sql`ALTER TABLE instruments ALTER COLUMN network TYPE net_t USING network::text::net_t`.execute(db)
  await sql`DROP TYPE net_t_old`.execute(db)
}
