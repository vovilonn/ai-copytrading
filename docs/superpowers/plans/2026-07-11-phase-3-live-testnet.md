# Фаза 3 — Живое исполнение на Bybit testnet — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Распознанные сигналы канала `2088626562` исполняются реальными ордерами на Bybit testnet: вход, лесенка TP, стоп, частичное и полное закрытие, реконсиляция после рестарта. Приватный WS Bybit стримит позиции/ордера/филлы в UI. Отказ и рестарт не создают дублей и не теряют состояние.

**Architecture:** `ExecutionPort` получает вторую реализацию — `BybitAdapter`, выбираемую по `EXECUTION_MODE=live`. Bybit REST-клиент (HMAC-подпись, токен-бакет rate-limiter, идемпотентные коды `110043`/`110072`). Приватный WS-мост Bybit (`position`/`order`/`execution`/`wallet`) обновляет зеркало в БД и публикует `domain_events`. Реконсиляция при старте: биржа — единственный источник истины, локальный журнал чинится по ней через `orderLinkId`/`symbol`. Реальный equity из `wallet-balance` идёт в сайзинг.

**Tech Stack:** тот же. Bybit V5 REST `api-testnet.bybit.com`, WS `stream-testnet.bybit.com` (по `BYBIT_NETWORK`).

**Спека:** `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md` (§4 изоляция/субаккаунты, §8 сайзинг, §9 исполнение, §13 отказоустойчивость)
**Исследования:** `docs/superpowers/research/bybit-execution.md` (§1 one-way, §2 плечо, §4 TP-лесенка, §5 SL, §8 orderLinkId, §9 отмена, §10 rate limits, §11 private WS, §14 реконсиляция)

## Global Constraints

- Node `>=22`, pnpm 10, ESM, импорты `.js`, `strict` + `noUncheckedIndexedAccess`.
- Деньги/цены/qty — `NUMERIC`/`Decimal`/`string`, никогда `number`.
- **Bybit testnet, один аккаунт на оба канала** (решение заказчика для Ф3): ключи `BYBIT_API_KEY`/
  `BYBIT_API_SECRET` из `.env` (сейчас testnet, баланс 1000 USDT). Код поддерживает per-channel ключи
  из `channels.bybit_api_key_enc` с ФОЛБЭКОМ на `.env`-ключ, если субаккаунт не заведён. Провижининг
  субаккаунтов — отдельный скрипт для mainnet (в Ф3 не запускается).
- **HMAC-подпись:** GET → `timestamp + apiKey + recvWindow + queryString`; POST → `timestamp + apiKey +
  recvWindow + jsonBody`. Заголовки `X-BAPI-API-KEY/TIMESTAMP/RECV-WINDOW/SIGN`.
- **Идемпотентные коды успеха:** `110043` (плечо не изменилось), `110072` (дубль orderLinkId) — трактовать
  как успех. `orderLinkId` детерминирован из координат сообщения, префикс `K` для live (не `D`).
- **Режим one-way** (`positionIdx=0`), выставить `switch-mode mode=0` на старте. Плечо `buyLeverage=sellLeverage`.
- **TP — reduceOnly limit-ордера** (свой orderLinkId на цель), **SL — trading-stop Full** (гарантированный
  market-close остатка). Не смешивать tpSize/slSize в одном вызове.
- **Rate limiter:** токен-бакет, GET ≤50/с, мутации ≤5-8/с на эндпоинт. `10006`/`10018` → ждать до
  `X-Bapi-Limit-Reset-Timestamp`, backoff.
- **Биржа — источник истины** при реконсиляции. `symbol + positionIdx=0` = текущая открытая `#TR-x`.
- Дельта-фреймы WS мержить поверх snapshot (markPrice не в каждой дельте).
- Секреты только в `.env`. Комментарии по-русски. Иконки только `lucide-react`.

---

## File Structure

```
apps/engine/src/bybit/
  rest-client.ts        # HMAC, rate-limiter, коды 110043/110072/10006/10018, retry
  private-ws.ts         # position/order/execution/wallet → БД + domain_events
  reconcile.ts          # старт-реконсиляция биржа↔журнал
apps/engine/src/execution/
  bybit.adapter.ts      # BybitAdapter implements ExecutionPort (реальные ордера)
  port.ts               # РАСШИРИТЬ: createExecutionPort('live') → BybitAdapter
apps/engine/src/state/
  equity.ts             # реальный equity из wallet-balance (кэш+рефреш)
apps/engine/src/
  main.ts               # РАСШИРИТЬ: реконсиляция при старте, private WS, TTL-свип, cancel-all
scripts/
  bybit-setup.mjs       # провижининг субаккаунтов (для mainnet; в Ф3 не запускается)
```

---

### Task 1: Bybit REST-клиент (HMAC, rate-limiter, идемпотентные коды)

**Files:** `apps/engine/src/bybit/rest-client.ts`, тест `apps/engine/test/bybit-rest.test.ts` (живой testnet).

**Interfaces:**
- `BybitRestClient({ apiKey, apiSecret, network })` с методами: `getWalletBalance()`, `getPositions(symbol?)`,
  `getOpenOrders(symbol?)`, `setLeverage(symbol, lev)`, `switchMode(symbol, mode)`, `createOrder(params)`,
  `cancelOrder({symbol, orderLinkId})`, `cancelAll(symbol)`, `setTradingStop(params)`, `getExecutions(...)`.
- Ошибки-успехи (110043/110072) возвращаются как `{ ok: true, idempotent: true }`, не бросают.

- [ ] **Step 1: Тесты (живой testnet, READ-only + идемпотентные)** — `getWalletBalance()` → totalEquity > 0
  (баланс пополнен); `getPositions()` → массив; `getOpenOrders()` → массив; подпись HMAC верна (retCode 0);
  `setLeverage(BTCUSDT, текущее_плечо)` дважды → второй раз `110043` трактуется как успех.
  Rate-limiter: заголовки `X-Bapi-Limit-*` парсятся. Live-тесты за флагом `BYBIT_LIVE_TESTS=1` (как AI_LIVE_TESTS).
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** HMAC (§ Global). Токен-бакет rate-limiter. Retry на 10006/10018 (ждать reset),
  на сетевых. 110043/110072 → идемпотентный успех. Хост по `BYBIT_NETWORK`.
- [ ] **Step 4: Тесты зелёные** — привести реальный wallet balance.
- [ ] **Step 5: Commit** — `feat(engine): Bybit REST-клиент с HMAC и rate-limiter`

---

### Task 2: BybitAdapter (ExecutionPort через реальный Bybit)

**Files:** `apps/engine/src/execution/bybit.adapter.ts`, `port.ts` (расширить фабрику), тест (живой testnet, за флагом).

**Interfaces:** `BybitAdapter implements ExecutionPort` — те же методы, что DryRunAdapter, но реальные вызовы.

- `placeEntry`: `switchMode(0)` (идемпотентно) → `setLeverage` (110043 ok) → `createOrder` (market/limit,
  orderLinkId `K...`). Пишет `orders`/`executions` из ответа.
- `placeTpLadder`: N reduceOnly limit-ордеров (`createOrder reduceOnly=true timeInForce=GTC`, orderLinkId
  `K...-T<i>`), доли округлены до qtyStep, последняя добивает остаток.
- `setStopLoss`: `setTradingStop stopLoss=<price> tpslMode=Full slSize=<остаток>`.
- `closePosition`: reduceOnly market close (orderLinkId `K...-C<i>`).
- `cancelOrder`/`cancelAll`: по символу.

- [ ] **Step 1: Тесты** — с моком `BybitRestClient`: `placeEntry` зовёт switchMode+setLeverage+createOrder
  с детерминированным orderLinkId `K`; повтор с тем же orderLinkId (мок возвращает 110072) → идемпотентный
  успех, не второй ордер; `placeTpLadder` из 3 целей → 3 createOrder reduceOnly с разными orderLinkId;
  `setStopLoss` → setTradingStop Full. `createExecutionPort('live', ...)` → BybitAdapter.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** Плечо/qty округляются по instruments (qtyStep, leverageStep). Все Decimal.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): BybitAdapter — реальное исполнение на Bybit V5`

---

### Task 3: Приватный WS-мост Bybit (position/order/execution/wallet)

**Files:** `apps/engine/src/bybit/private-ws.ts`, тест (живой testnet, за флагом).

**Interfaces:** `BybitPrivateWs({ apiKey, apiSecret, network, db, onEvent })` — подключается, аутентифицируется
(`op:auth`, `sign=HMAC(secret, "GET/realtime"+expires)`), подписывается на `position.linear`, `order.linear`,
`execution.linear`, `wallet`. На пуш: обновляет `positions`/`orders`/`executions` в БД, публикует `domain_events`
(`position.upsert`, `position.close`, `order.resolved`). Реконнект с реаутентификацией. `seq` как водяной знак.

- [ ] **Step 1: Тесты** — живой хендшейк (`op:auth` success, `subscribe` success). Мок-тест: пуш `execution`
  с `closedSize>0` → трактуется как закрытие; атрибуция к цели по `orderLinkId`; `position` с `size=0` →
  `position.close` + освобождение владения символом (`releaseSymbol`) + `cancel-all` висящих ордеров (R8).
  Мерж дельт поверх snapshot (markPrice не в каждой дельте).
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** Реаутентификация при реконнекте. `execution.closedSize` → атрибуция филла
  к сделке/ноге по `orderLinkId`, пересчёт `realized_pnl`. `position size→0` → закрытие + cancel-all.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): приватный WS-мост Bybit — позиции, ордера, филлы`

---

### Task 4: Реконсиляция при старте + реальный equity

**Files:** `apps/engine/src/bybit/reconcile.ts`, `apps/engine/src/state/equity.ts`, тест.

**Interfaces:**
- `reconcileOnStart(db, rest): Promise<{ fixed: number }>` — процедура §14: `position/list` (что открыто) +
  `order/realtime` (что висит) → слить с журналом по `orderLinkId`/`symbol`; расхождение → биржа истина,
  журнал чинится (позиция есть, а TR закрыт → пометить needs_review/восстановить; TR открыт, а позиции нет →
  закрыть TR). `createdTime` защищает от «чужой» позиции.
- `getEquity(rest, subaccount?): Promise<Decimal>` — реальный `totalEquity` из `wallet-balance`, кэш+рефреш.

- [ ] **Step 1: Тесты** — реконсиляция: позиция на бирже без TR в журнале → создаётся/помечается;
  TR открыт в журнале без позиции на бирже → закрывается по бирже; совпадение → без изменений.
  `getEquity` → реальный баланс (живой, за флагом).
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** Сайзинг (задача Ф1 `computeSize`) теперь получает реальный equity вместо
  хардкода '1000'. `symbol+positionIdx=0` = активная #TR-x.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): реконсиляция при старте и реальный equity в сайзинг`

---

### Task 5: Интеграция live-режима в main + TTL-отмена + cancel-all

**Files:** `apps/engine/src/main.ts` (расширить), `apps/engine/src/execution/port.ts`, тест.

- [ ] **Step 1: Тесты** — при `EXECUTION_MODE=live` фабрика даёт BybitAdapter; при `dry_run` — DryRunAdapter
  (единая точка ветвления, без `if` по коду). TTL-свип: entry-лимитка старше `limit_ttl_sec` (7 дней) →
  cancelOrder; явное «лимитка не актуальна» → cancel раньше. Ключ канала: per-channel из БД с фолбэком на .env.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** main при старте: реконсиляция → private WS → engine-loop. Планировщик:
  TTL-свип лимиток, периодическая реконсиляция (дрейф), рефреш equity. cancel-all при `position size→0`
  (через private WS, задача 3).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): live-режим в main, TTL-отмена лимиток, cancel-all`

---

### Task 6: E2E на Bybit testnet + приёмка Ф3

**Files:** `apps/engine/test/live-e2e.test.ts` (за флагом `BYBIT_LIVE_TESTS=1`), обновление `LOOP_STATE.md`,
`docker-compose.yml` (engine env `EXECUTION_MODE`).

Баланс testnet пополнен (1000 USDT). e2e ставит РЕАЛЬНЫЕ ордера на testnet малым размером.

- [ ] **Step 1: E2E-сценарий** (живой testnet, малый notional, символ `BTCUSDT`/`SOLUSDT`):
  1. Открыть market-позицию малого размера → проверить `position/list` (size>0, наш orderLinkId).
  2. Поставить лесенку из 2 TP (reduceOnly) → проверить `order/realtime` (2 условных).
  3. Поставить/перенести SL (trading-stop Full).
  4. Частичное закрытие → `position size` уменьшился, `execution.closedSize>0`.
  5. Полное закрытие → `position size=0`, `cancel-all` снял висящие TP, владение символом освобождено.
  6. **Рестарт-реконсиляция:** открыть позицию, «убить» engine (не закрывая на бирже), запустить снова →
     реконсиляция восстанавливает `#TR-x` из биржи, дублей нет.
  7. **Идемпотентность:** повторная отправка того же ордера (тот же orderLinkId) → 110072, второго ордера нет.
- [ ] **Step 2: Прогнать e2e** на testnet. Привести фактический вывод каждого шага (orderId, position size,
  execution). После теста — закрыть все тестовые позиции и отменить ордера (cleanup).
- [ ] **Step 3: Приёмка вручную.** Переключить канал `2088626562` в live (`EXECUTION_MODE=live`,
  `channel_settings.enabled=true`), дать engine исполнить свежий сигнал (или воспроизвести один малым
  размером). Открыть UI: на Positions — реальная позиция с биржи, mark/PnL/liq из приватного WS; на Actions —
  действие executed. Привести SQL и скриншот. Форум оставить в dry_run (Ф2 не гарантирует лимитки).
- [ ] **Step 4: Отказоустойчивость вживую.** Ручное закрытие позиции в терминале Bybit → `position size→0`
  из WS → engine снимает висящие ордера, освобождает символ, закрывает `#TR-x`. Привести вывод.
- [ ] **Step 5: Обновить `LOOP_STATE.md`** — Ф3 выполнена, грабли.
- [ ] **Step 6: Commit** — `feat: фаза 3 — живое исполнение на Bybit testnet`

---

## Definition of Done для Ф3

- Сигналы канала `2088626562` исполняются реальными ордерами на Bybit testnet: вход, лесенка TP, стоп,
  частичное и полное закрытие.
- Приватный WS Bybit стримит позиции/ордера/филлы в UI; mark/PnL/liq — реальные с биржи.
- Рестарт engine с открытыми позициями восстанавливает состояние из биржи (реконсиляция), дублей нет.
- Повторная отправка ордера (тот же orderLinkId) → 110072, второго ордера нет.
- Ручное закрытие в терминале Bybit → engine снимает висящие ордера и закрывает `#TR-x`.
- Реальный equity из wallet-balance идёт в сайзинг.
- `pnpm test` (без live-флага) и `pnpm typecheck` зелёные; live-тесты за `BYBIT_LIVE_TESTS=1`.

## Что осознанно не делается в Ф3

Провижининг субаккаунтов на testnet (заказчик выбрал один аккаунт; скрипт для mainnet готов, но не
запускается). Форум в live (лимитки/доборы форума — Ф-later; в Ф3 форум остаётся dry_run). Реальные деньги
mainnet (только testnet). История закрытых сделок с Win Rate — Ф4.
