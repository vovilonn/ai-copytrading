import { Kysely, sql } from 'kysely'

// Task 1 (мониторинг PnL/баланса, docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md):
// фундамент под живой баланс аккаунта. Движок будет периодически (Task 3) писать сюда снимок
// getWalletBalance с Bybit — API (Task 2) читает последнюю строку для GET /account/wallet,
// не дублируя Bybit-клиент на стороне api.
//
// channel_id — BIGINT NULL (без NOT NULL, в отличие от большинства FK в 001_initial.ts):
// NULL означает снапшот уровня ВСЕГО demo-аккаунта (сейчас единственный источник — один
// demo-аккаунт на всех каналов, per-channel PnL считается виртуально из trades/positions,
// см. «Решения» плана). Ненулевой channel_id — задел под будущие реальные субаккаунты
// Bybit на канал (сейчас не провижинится, колонка зарезервирована).
//
// NUMERIC(30,10) — та же точность, что и у остальных денежных колонок схемы (trades.avg_entry,
// positions.avg_price и т.д., см. 001_initial.ts) — деньги не теряют точность на строковом round-trip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE wallet_snapshots (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id         BIGINT REFERENCES channels(id),
      total_equity       NUMERIC(30,10) NOT NULL,
      available_balance  NUMERIC(30,10) NOT NULL,
      currency           TEXT NOT NULL DEFAULT 'USDT',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Индекс под "последний снапшот для channel_id" (WHERE channel_id IS NULL ORDER BY created_at
  // DESC LIMIT 1 — account-level; либо конкретный канал, когда появятся субаккаунты).
  await sql`CREATE INDEX idx_wallet_snapshot_latest ON wallet_snapshots (channel_id, created_at DESC)`.execute(db)
}

// Аддитивная миграция без разрушающих изменений схемы (ни ALTER TYPE, ни каст существующих
// колонок) — откат безопасен всегда, в отличие от 004_archived_status.ts/005_demo_network.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS wallet_snapshots`.execute(db)
}
