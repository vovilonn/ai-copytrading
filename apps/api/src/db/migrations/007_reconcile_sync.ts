import { Kysely, sql } from 'kysely'

// Полная реконсиляция с Bybit: догон истории после даунтайма (REST) + подтягивание ручных
// действий оператора, сделанных прямо в UI биржи. Фундамент — новые колонки в executions
// (происхождение и связь строки исполнения) и trades (флаги ручного вмешательства).
//
// ЗАЧЕМ КАЖДАЯ КОЛОНКА (важно для будущего читателя — эти решения продиктованы поведением
// живого API Bybit, а не вкусом):
//
// executions.bybit_order_id — `/v5/position/closed-pnl` (ЕДИНСТВЕННЫЙ источник реального
//   реализованного PnL по закрытой позиции) НЕ отдаёт `orderLinkId` — только `orderId`. Наш
//   executions.order_link_id (001_initial.ts) для джойна с closed-pnl поэтому бесполезен: без
//   отдельной колонки с биржевым orderId закрытый PnL просто не с чем сопоставить.
//
// executions.source ('ws' | 'rest') — КРИТИЧНО для патча PnL из closed-pnl. Строки, пришедшие
//   по WebSocket, несут точный `execPnl` на КАЖДЫЙ филл — их патчить нельзя, это затрёт точные
//   данные агрегатом. REST-строки execPnl не содержат ВООБЩЕ: `/v5/execution/list` его не
//   возвращает (проверено живьём) — только их и разрешено доливать из closed-pnl. Без этой
//   колонки два класса строк неразличимы, и патч неизбежно повреждает ws-данные.
//   DEFAULT 'ws' — все строки, существующие на момент миграции, писал private-ws.
//
// executions.create_type — маркер происхождения филла со стороны Bybit:
//   `CreateByUser` — обычный ордер; `CreateByClosing` — оператор закрыл позицию руками из UI
//   Bybit; `CreateByStopLoss` — сработал выставленный trading-stop; `CreateByLiq` — ликвидация.
//   Именно по нему реконсиляция отличает наши ордера от ручного вмешательства оператора.
//
// executions.bybit_seq — монотонный курсор Bybit (тот же смысл, что и positions.bybit_seq в
//   001_initial.ts): защита от применения устаревшего снапшота, когда REST-догон и WS-поток
//   гонятся за одну и ту же строку.
//
// executions.exec_type (`Trade` | `Funding` | `AdlTrade` | `BustTrade` | `Settle`) — УЖЕ СУЩЕСТВУЕТ
//   с 001_initial.ts, здесь не добавляется (повторный ADD COLUMN упал бы). Фиксируем семантику,
//   которую обязана соблюдать реконсиляция: `Funding` (списание фандинга по открытой позиции) —
//   это НЕ сделка, он идёт ТОЛЬКО в комиссии и не имеет права влиять на размер позиции и среднюю
//   цену входа.
//
// trades.needs_review — сделка разошлась с биржей настолько, что автоматика не берётся её
//   свести: нужен разбор оператором (флаг для UI, а не статус — статус сделки остаётся честным).
//
// trades.manual_override — оператор вмешался в сделку руками на бирже. После этого канал больше
//   НЕ двигает SL/TP этой сделки: сигнал из телеграма не должен затирать решение человека.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE executions ADD COLUMN bybit_order_id TEXT`.execute(db)
  // Частичный индекс: джойн closed-pnl → executions идёт строго по НЕ-NULL orderId, а строки
  // с NULL (всё, что записано до этой миграции) в индексе только занимали бы место.
  await sql`
    CREATE INDEX idx_exec_bybit_order ON executions (bybit_order_id) WHERE bybit_order_id IS NOT NULL
  `.execute(db)
  await sql`ALTER TABLE executions ADD COLUMN source TEXT NOT NULL DEFAULT 'ws'`.execute(db)
  await sql`ALTER TABLE executions ADD COLUMN create_type TEXT`.execute(db)
  await sql`ALTER TABLE executions ADD COLUMN bybit_seq BIGINT`.execute(db)

  await sql`ALTER TABLE trades ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE trades ADD COLUMN manual_override BOOLEAN NOT NULL DEFAULT false`.execute(db)
}

// Аддитивная миграция без разрушающих изменений схемы (ни ALTER TYPE, ни каст существующих
// колонок) — откат безопасен всегда, как и в 006_wallet_snapshots.ts. Индекс уходит вместе с
// колонкой (DROP COLUMN роняет зависящие от неё индексы), но дропаем явно — ради читаемости.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_exec_bybit_order`.execute(db)
  await sql`ALTER TABLE executions DROP COLUMN IF EXISTS bybit_order_id`.execute(db)
  await sql`ALTER TABLE executions DROP COLUMN IF EXISTS source`.execute(db)
  await sql`ALTER TABLE executions DROP COLUMN IF EXISTS create_type`.execute(db)
  await sql`ALTER TABLE executions DROP COLUMN IF EXISTS bybit_seq`.execute(db)

  await sql`ALTER TABLE trades DROP COLUMN IF EXISTS needs_review`.execute(db)
  await sql`ALTER TABLE trades DROP COLUMN IF EXISTS manual_override`.execute(db)
}
