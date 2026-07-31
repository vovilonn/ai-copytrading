// Писатель wallet_snapshots (Ф.., задача 3, план
// docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md, Task 3): движок периодически (ТОЛЬКО
// в live — см. main.ts) пишет account-level снимок баланса, который читает `GET /account/wallet`
// (Task 2, apps/api). Источник данных — тот же `getWalletBalance` (rest-client.ts), что и у
// `getEquity` (state/equity.ts), но БЕЗ кэша: снапшот должен отражать состояние на момент вызова
// планировщика (кэш getEquity существует ради риск-сайзинга внутри одного тика пайплайна, это
// другая задача — история баланса не должна "отставать" на TTL кэша).
//
// channel_id: NULL — снапшот всего аккаунта (общий аккаунт из env либо аккаунт, обслуживающий
// несколько каналов); номер канала — когда у канала СВОЙ субаккаунт и снапшот описывает именно его
// (см. runtime/account-registry.ts). Раньше здесь всегда стоял NULL — аккаунт был один (
// demo-аккаунт на весь движок, design plan «Решения»: "Баланс: один demo-аккаунт... Реальные
// субаккаунты на demo недоступны — DTO заложить под будущее, но не провижинить").

import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { BybitRestClient, WalletBalance } from '../bybit/rest-client.js'
import { pickNonEmptyEquity } from './equity.js'

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
export async function writeWalletSnapshot(
  db: Kysely<DB>,
  rest: WalletSnapshotRestClient,
  /** Канал субаккаунта, если этот аккаунт обслуживает ровно один канал; null — общий аккаунт
   *  (или аккаунт нескольких каналов): снапшот тогда описывает весь аккаунт, а не канал. */
  channelId: number | null = null,
): Promise<void> {
  const balance: WalletBalance = await rest.getWalletBalance()

  // F4 (адверсариальное ревью): Bybit документированно возвращает totalEquity='' (сразу после
  // депозита/переброса маржи, см. equity.ts::resolveEquityValue) — вставка '' в NUMERIC(30,10)
  // NOT NULL уронила бы INSERT и потеряла снапшот. Переиспользуем ту же деградацию, что getEquity
  // (pickNonEmptyEquity: totalEquity -> totalAvailableBalance). Если ОБА поля пусты — НЕ вставляем
  // строку, логируем и пропускаем тик (следующий через ~30с). Никогда не пишем '' в NUMERIC.
  const totalEquity = pickNonEmptyEquity(balance)
  if (totalEquity === null) {
    console.warn(
      '[wallet-snapshot] totalEquity и totalAvailableBalance оба пусты в ответе Bybit — пропускаю снапшот, строку не вставляю (следующий тик через ~30с)',
    )
    return
  }
  // available_balance тоже NOT NULL: если доступный остаток неизвестен, кладём equity, чтобы в
  // колонку не попала пустая строка. Это ЗАМЕТНО в UI («Available» = «Total equity»), и именно так
  // выглядел баг до 31.07.2026: Bybit отдаёт totalAvailableBalance пустым на UNIFIED-аккаунте, а
  // фолбэк молча показывал полный депозит доступным. Теперь остаток считает сам rest-client
  // (resolveAvailableBalance), и сюда пустая строка приходит, только если биржа не дала вообще
  // ничего — тогда это по-прежнему честнее, чем выдумать число.
  const availableBalance = balance.totalAvailableBalance !== '' ? balance.totalAvailableBalance : totalEquity

  await db
    .insertInto('wallet_snapshots')
    .values({
      channel_id: channelId,
      total_equity: totalEquity,
      available_balance: availableBalance,
      currency: 'USDT',
    })
    .execute()
}
