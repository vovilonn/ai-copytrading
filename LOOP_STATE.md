# LOOP_STATE

## Goal

Фаза 3: фикс live-ядра по адверсариальному ревью (перед e2e с реальными ордерами) — Critical C1
(SL атомарно с входом) + Important I1 (идемпотентная отмена SL) + Important I3 (WS-топики по
префиксу) + Important I2 (staleness/slippage-гейт) + Minor M3 (getEquity fallback) + Minor M1
(orphan reduceOnly-очистка). Полный отчёт — `.superpowers/sdd/p3-core-fix-report.md`.

## Status

- [x] C1: `BybitAdapter.placeEntry` передаёт `stopLoss` атомарно в `rest.createOrder` (Bybit V5
      `order/create` принимает `stopLoss`/`slTriggerBy`); `pipeline.ts::handleEntrySignal` больше
      не делает отдельный `setStopLoss` после TP-лесенки. `EntryOrder.stopLoss` — опционально
      (`add`/доливка его не передаёт). `DryRunAdapter` — паритетная атомарная запись.
- [x] I1: `BybitAdapter.cancelOrder` различает SL-trading-stop (purpose='sl', bybit_order_id=null)
      → `setTradingStop(stopLoss='0')`, обычный ордер → `rest.cancelOrder`. `rest-client.ts`:
      retCode 110001 ("order not exists") — идемпотентный успех.
- [x] I3: `private-ws.ts::handleMessage` матчит топик по `split('.')[0]` — работает и для
      `position.linear`, и для bare `position`; `default`-кейс логирует неизвестный топик.
- [x] I2: гейт staleness/slippage в `handleEntrySignal` — `deps.getMarkPrice`/
      `deps.maxEntrySlippagePct` (PipelineDeps), fail-open в dry_run/при сбое похода за ценой.
      `main.ts` (live) подключает `rest.getPositions(symbol)` (стаб-позиция несёт markPrice даже
      при size=0). `MAX_ENTRY_SLIPPAGE_PCT` — новый env, дефолт 0.5, добавлен в `.env.example`.
- [x] M3: `state/equity.ts::resolveEquityValue` — totalEquity пуст → totalAvailableBalance → кэш
      → throw (в этом порядке).
- [x] M1: `reconcileOnStart` — шаг В (после коммита транзакции): осиротевшие reduceOnly-остатки
      (TP/SL/close) по символам без открытой позиции отменяются по одному через `rest.cancelOrder`
      (не cancelAll — не трогает legitimate entry/add лимитки). Новое поле
      `ReconcileResult.orphansCancelled`. Работает и на старте, и на периодическом тике (main.ts) —
      одна функция на оба места.
- [x] `pnpm --filter engine test` — 345 passed, 10 skipped (было 321/10 до этого лупа, +24 теста).
- [x] `pnpm typecheck` — 6/6 пакетов зелёные.
- [x] Живая проверка (`EXECUTION_MODE=live pnpm --filter engine exec tsx src/main.ts`, ~15с, оба
      канала `enabled=false`): `reconcileOnStart: opened=0 closed=0 flagged=0 orphansCancelled=0`;
      `equity: 998.998`; `[private-ws] auth success` → `subscribe success`; 0 строк `orders` с
      префиксом `K` после прогона (подтверждено SQL). Процесс убит, `.env` не менялся
      (EXECUTION_MODE=dry_run в файле — без изменений).
- [x] Коммит `apps/engine` + `.env.example` + `LOOP_STATE.md`.

## LOOP ЗАВЕРШЁН

## Грабли этого лупа

- `EntryOrder.stopLoss` сделан ОПЦИОНАЛЬНЫМ (не обязательным), хотя "идеальная" типовая гарантия
  атомарности выглядела бы строже как required-поле. Причина: десятки уже существующих юнит-тестов
  адаптеров (`bybit-adapter.test.ts`, `dry-run.adapter.test.ts`) вызывают `placeEntry` изолированно
  без SL (сценарии TP/close/cancelOrder, не про исходный вход) — required-поле сломало бы их все
  на typecheck без единого изменения поведения. `pipeline.ts` — единственный реальный вызывающий
  код в проде — гарантирует передачу `stopLoss` для `purpose='entry'` сам по себе (intent.sl
  обязателен в грамматике парсера), инвариант держится на уровне вызывающей стороны, не типа.
- SL как "trading-stop, не отдельный ордер" (bybit_order_id=null) — уже существовавший инвариант
  до этой задачи, только теперь ЕЩЁ и ставится атомарно с `order/create`, а не отдельным
  `position/trading-stop`. `cancelOrder` (I1) опирается ИМЕННО на связку `purpose='sl' &&
  bybit_order_id===null` для маршрутизации в `setTradingStop(0)` — если когда-нибудь появится
  реальный SL-ордер с собственным orderId (иной механизм Bybit), этот гейт придётся пересмотреть.
- M1 (orphan-очистка) реализована ПОЛНОСТЬЮ (не просто задокументирована) — оказалось несложно,
  т.к. `reconcileOnStart` уже читал `getPositions`/`getOpenOrders` ДО транзакции; потребовалось
  расширить `ReconcileRestClient` до `cancelOrder` и обновить 6 существующих `.toEqual()`-тестов
  под новое поле `orphansCancelled` (иначе они падали на несовпадении формы объекта).
- Живая проверка была на аккаунте БЕЗ открытых позиций — I3 (`.linear`-топики) подтверждён живым
  хендшейком (auth+subscribe success), но НЕ живыми data-пушами `position`/`execution`/`order`
  (нечему прийти на пустом аккаунте) — юнит-тест на смоделированных `.linear`-фреймах закрывает
  этот пробел, но полное сквозное подтверждение — только на e2e с реальным входом (задача 6).
