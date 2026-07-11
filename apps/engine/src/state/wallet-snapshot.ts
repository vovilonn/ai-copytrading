// Писатель wallet_snapshots (Ф.., задача 3, план
// docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md, Task 3): движок периодически (ТОЛЬКО
// в live — см. main.ts) пишет account-level снимок баланса, который читает `GET /account/wallet`
// (Task 2, apps/api). Источник данных — тот же `getWalletBalance` (rest-client.ts), что и у
// `getEquity` (state/equity.ts), но БЕЗ кэша: снапшот должен отражать состояние на момент вызова
// планировщика (кэш getEquity существует ради риск-сайзинга внутри одного тика пайплайна, это
// другая задача — история баланса не должна "отставать" на TTL кэша).
//
// channel_id всегда NULL здесь — единственный вид снапшота, который сейчас провижинится (один
// demo-аккаунт на весь движок, design plan «Решения»: "Баланс: один demo-аккаунт... Реальные
// субаккаунты на demo недоступны — DTO заложить под будущее, но не провижинить").

import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { BybitRestClient, WalletBalance } from '../bybit/rest-client.js'

/** Узкий срез BybitRestClient — тот же приём сужения типа мока, что и EquityRestClient
 *  (state/equity.ts) и BybitAdapterRestClient (execution/bybit.adapter.ts). */
export type WalletSnapshotRestClient = Pick<BybitRestClient, 'getWalletBalance'>

/**
 * Зовёт `getWalletBalance` и вставляет одну строку в `wallet_snapshots` (channel_id=null,
 * currency='USDT'). Деньги — строки НАПРЯМУЮ из ответа Bybit (totalEquity/totalAvailableBalance
 * уже строки, NUMERIC(30,10) в БД не теряет точность на round-trip) — Decimal здесь не нужен,
 * это чистая передача значения без арифметики.
 *
 * Не ловит ошибки сама — вызывающая сторона (main.ts: планировщик и старт live) оборачивает
 * вызов в try/catch, чтобы сбой похода за балансом (сеть/rate-limit Bybit) не ронял ни старт
 * движка, ни сам планировщик.
 */
export async function writeWalletSnapshot(db: Kysely<DB>, rest: WalletSnapshotRestClient): Promise<void> {
  const balance: WalletBalance = await rest.getWalletBalance()
  await db
    .insertInto('wallet_snapshots')
    .values({
      channel_id: null,
      total_equity: balance.totalEquity,
      available_balance: balance.totalAvailableBalance,
      currency: 'USDT',
    })
    .execute()
}
