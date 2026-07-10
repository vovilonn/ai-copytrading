# Фаза 1 — Детерминированный разбор канала 2088626562 в dry-run — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Прогон реального трафика канала `2088626562` через детерминированный парсер → сделки `#TR-x`, леги и симулированные позиции в UI, без единого обращения к бирже. Повторный прогон не создаёт дублей.

**Architecture:** Новый процесс `apps/engine` — единственный обработчик пайплайна и (в будущих фазах) писатель к бирже. Он читает необработанные `messages` из очереди на `SKIP LOCKED`, гонит их через нормализацию → адаптер канала → reconciler → risk → `ExecutionPort`. В Ф1 `ExecutionPort` реализован только `DryRunAdapter`: он пишет `orders`/`executions`/`positions`/`trades`/`trade_legs` в БД и публикует `domain_events`, но не звонит на Bybit. Денежная математика — чистые функции с property-тестами. Парсер тестируется на 100 реальных сообщениях дампа как фикстурах.

**Tech Stack:** тот же, что Ф0. Плюс `decimal.js` для денежной арифметики.

**Спека:** `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md` (§6 пайплайн, §8 сайзинг, §9 исполнение, §10 модель данных)
**Исследования:** `docs/superpowers/research/channel-adapters.md` (правила, regex, словари, дамп-факты), `docs/superpowers/research/bybit-execution.md` (§6 формулы liq/плеча, §7 округления, §8 orderLinkId)

## Global Constraints

- Node `>=22`, pnpm 10, ESM, импорты с расширением `.js`, `strict` + `noUncheckedIndexedAccess`.
- **Все деньги, цены, количества — `NUMERIC` в БД и `string`/`Decimal` в коде. Никогда `number` для денег.** Для арифметики — `decimal.js`.
- `BIGINT` читается числом (`setTypeParser(INT8, Number)` уже зарегистрирован).
- Провайдеры NestJS — с явным `@Inject(Class)` (vitest/esbuild не эмитит `design:paramtypes`).
- Тесты работают ТОЛЬКО с базой `copytrade_test` через `packages/test-db`. Рабочую БД не трогают.
- Идемпотентность: `orderLinkId` детерминирован из координат сообщения `<prefix><channelOrd>-<tgMessageId>-<actionIdx>-<purpose><legIdx>`, `prefix='D'` для dry-run. `legIdx` — чистая функция от сообщения: для TP индекс цели, для входа/добора — `0`. `retCode` `110072` (dup) и `110043` — успех.
- Символ резолвится → проверяется по `instruments` активной сети (`status='Trading'`) → иначе `Skipped: symbol_not_listed`.
- `EXECUTION_MODE` — единственная точка ветвления: порт `ExecutionPort` с `DryRunAdapter` (Ф1) и `BybitAdapter` (Ф3). Никаких `if (dryRun)` по коду.
- Комментарии по-русски и только там, где объясняют неочевидное. Иконки только `lucide-react`. Источник дизайна — `design/project/Admin.dc.html`.
- Секреты только в `.env`.

---

## File Structure

```
packages/shared/src/
  domain.ts          # ParsedIntent, DeltaOp, ParseContext, ParsedResult, Route, Side (из channel-adapters §10)
  numbers.ts         # NUM/toNum/splitKeycaps (проверенные regex из research §3) — чистые
  ws-events.ts       # + action.new, action.skipped, position.upsert, position.close, channel.stats

apps/api/src/
  instruments/instruments.service.ts   # кэш instruments-info + risk-limit, гейт status=Trading
  instruments/instruments.controller.ts# (внутренний, для engine через БД — REST не обязателен)
  actions/actions.controller.ts        # GET /api/actions с фильтрами
  positions/positions.controller.ts    # GET /api/positions, GET /api/positions/stats

apps/engine/                            # НОВЫЙ процесс
  src/main.ts                          # bootstrap, loop по очереди messages
  src/pipeline.ts                      # orchestration: normalize→parse→reconcile→risk→execute
  src/normalize.ts                     # ё→е, э→е, lowercase, trim (чистая)
  src/symbol-resolver.ts               # алиасы→BYBITSYMBOL (словарь research §9), isListed
  src/adapters/ch1.adapter.ts          # правила R1-R5 (research §1)
  src/adapters/registry.ts             # adapterId → ChannelAdapter
  src/reconciler.ts                    # ParsedResult → decision → actions (в Ф1 только det-путь)
  src/risk/sizing.ts                   # чистая: notional, qty (§8 спеки)
  src/risk/leverage.ts                 # чистая: lev_max_safe, liqPrice (§6 research)
  src/state/trades.ts                  # создание/обновление trades, trade_legs, symbol_ownership
  src/execution/port.ts               # ExecutionPort интерфейс + orderLinkId
  src/execution/dry-run.adapter.ts    # пишет orders/executions/positions, не звонит бирже
  src/execution/order-link-id.ts       # детерминированный ключ (чистая)

apps/web/src/routes/
  actions.tsx                          # страница Actions (был заглушкой)
  positions.tsx                        # страница Positions (был заглушкой)
```

---

### Task 1: Instruments-кэш (символы, статус, MMR, округления)

**Files:** `apps/api/src/instruments/instruments.service.ts`, `apps/engine/...` (шарится через БД-таблицу `instruments`), тест `apps/api/test/instruments.e2e.test.ts`

**Interfaces:**
- Produces: `InstrumentsService.refresh(): Promise<number>` (тянет с Bybit, upsert в `instruments`), `InstrumentsService.get(symbol): Instrument | null`, `InstrumentsService.isTrading(symbol): boolean`.
- `Instrument`: `{ symbol, network, status, qtyStep: string, minQty: string, tickSize: string, minNotional: string, maxLeverage: string, leverageStep: string, mmr: string }`.

- [ ] **Step 1: Тест** — `refresh()` наполняет таблицу с публичного `GET /v5/market/instruments-info?category=linear` активной сети (`BYBIT_NETWORK`); `isTrading('BTCUSDT')` → true; `isTrading('GRASSUSDT')` на testnet → false (`status != 'Trading'`); `get('BTCUSDT').mmr` из `risk-limit` tier1 = `'0.005'`.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать.** Тянуть обе страницы (`instruments-info` + `risk-limit` по каждому нужному символу или пакетно), брать `lotSizeFilter.qtyStep/minOrderQty/minNotionalValue`, `priceFilter.tickSize`, `leverageFilter.maxLeverage/leverageStep`, `status`. MMR — из `risk-limit` tier1 `maintenanceMargin`. Хост по `BYBIT_NETWORK` (`api-testnet` / `api`). Публичный эндпоинт, ключ не нужен.
- [ ] **Step 4: Тест зелёный.**
- [ ] **Step 5: Commit** — `feat(engine): кэш инструментов Bybit с гейтом status=Trading`

---

### Task 2: Числа, нормализация, символ-резолвер (чистые функции)

**Files:** `packages/shared/src/numbers.ts`, `apps/engine/src/normalize.ts`, `apps/engine/src/symbol-resolver.ts`, тесты рядом.

**Interfaces:**
- `parseNumbers(text): number[]`, `toNum(s): number`, `splitKeycaps(s): number[]` (research §3, дословно).
- `normalize(text): string` — lowercase, `ё→е`, `э→е`, схлопывание пробелов.
- `resolveSymbol(raw: string, isListed: (s) => boolean): string | null` — словарь алиасов research §9 (кириллица со склонениями + `#TICKER/USDT`), Unicode-границы `\p{L}\p{N}`.

- [ ] **Step 1: Тесты на реальных строках дампа** (research §3 и §9): `62 000$`→`62000` (U+0020!); `1.5273-1.4735`→`[1.5273,1.4735]`; `1️⃣80.82️⃣82.33️⃣84`→`[80.8,82.3,84]`; `битка/битку/битке`→`BTCUSDT`; `эфира`→`ETHUSDT`; `солане`→`SOLUSDT`; `#GRASS/USDT`→`GRASSUSDT`; `#O`→`OUSDT`; `шортовом`/`битке` в аналитике НЕ дают направление/символ ложно (Unicode-границы).
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** дословно по research §3/§4/§9. Критично: `\b` не работает перед кириллицей — использовать `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])/u`.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): нормализация, парсинг чисел, резолвер символов`

---

### Task 3: Адаптер CH1 (правила R1–R5) на дампе

**Files:** `packages/shared/src/domain.ts` (типы из research §10), `apps/engine/src/adapters/ch1.adapter.ts`, `apps/engine/src/adapters/registry.ts`, тест `apps/engine/test/ch1.adapter.test.ts` с фикстурой из дампа.

**Interfaces:**
- `interface ChannelAdapter { parse(ctx: ParseContext): ParsedResult }`.
- Типы `ParsedIntent`, `DeltaOp`, `ParsedResult`, `Route`, `Side` — из research §10, перенеси в `domain.ts`.

- [ ] **Step 1: Тест-фикстура.** Скопировать `temp/tg-dump/ch-2088626562/messages.jsonl` в `apps/engine/test/fixtures/ch1.jsonl` (дамп в `.gitignore` — фикстуру закоммить). Прогнать все 100 сообщений через `parse`, проверить агрегат: DET=62, NOISE=38, ложных SIGNAL из обзоров=0 (research §0). Плюс точечные: `2796`→`entry_signal LIT short entry=[1.5273,1.4735] tp=[1.4428,1.3926,1.2777] sl=1.7137 risk=2`; `2818`→multi `[PENDLE, AERO, BB]`; `#BTC обзор`→noise.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать** R1 (entry signal), R2 (multi_mgmt), R3 (delta reply), R4 (delta standalone), R5 (noise) — research §1. Action-лексикон CH1 — таблица research §1. Нет SL → route `skip`, reason `no_SL`.
- [ ] **Step 4: Тест зелёный** — покрытие совпадает с research §0 (допустимо расхождение ±1, задокументировать).
- [ ] **Step 5: Commit** — `feat(engine): адаптер CH1 — детерминированный парсер сигналов`

---

### Task 4: Денежная математика — сайзинг и плечо (чистые, property-тесты)

**Files:** `apps/engine/src/risk/sizing.ts`, `apps/engine/src/risk/leverage.ts`, тесты рядом. Добавить `decimal.js`.

**Interfaces:**
- `computeLeverage({ entry, sl, side, mmr, channelMaxLev, instrMaxLev, leverageStep, buf }): Decimal` — `1/(d + mmr + buf)`, floor к `leverageStep`, clamp `[1, min(channelMaxLev, instrMaxLev)]`, где `d = |entry−sl|/entry`.
- `liqPrice({ entry, side, lev, mmr }): Decimal` — long `entry·(1−1/lev+mmr)`, short `entry·(1+1/lev−mmr)`.
- `computeSize({ riskPct?, equity, tradeSize, entry, sl, minNotional, maxSymbolNotional?, qtyStep }): { notional, qty } | { skip: reason }` — есть `riskPct` → `notional=(riskPct/100·equity)/d`; иначе `notional=tradeSize`; clamp по `maxSymbolNotional`; `qty=floor_to(qtyStep, notional/entry)`; если `notional<minNotional` → skip.

- [ ] **Step 1: Тесты + property-тесты.**
  - Проверка из research §6: `LIT short entry=1.5004 sl=1.7137 mmr=0.005 buf=0.005` → `lev≈6` (floor от 6.57).
  - Проверка §6: `entry=70000 lev=10 mmr=0.005 short` → `liqPrice=76650`; long → `63350`.
  - **Property:** для любых валидных `entry`, `sl`, `side` при `lev = computeLeverage(...)` выполняется `liqPrice` за `sl` (для long `liq < sl`, для short `liq > sl`). Прогнать 1000 случайных входов.
  - **Property:** `computeSize` никогда не даёт `notional > maxSymbolNotional` и `qty` кратно `qtyStep`.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** на `decimal.js`. `floor_to(step, x)` — `x.div(step).floor().mul(step)`.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): сайзинг и выбор плеча — чистые функции с property-тестами`

---

### Task 5: orderLinkId и state (trades, legs, ownership)

**Files:** `apps/engine/src/execution/order-link-id.ts`, `apps/engine/src/state/trades.ts`, тесты рядом.

**Interfaces:**
- `orderLinkId({ mode, channelOrd, tgMessageId, actionIndex, purpose, legIndex }): string` — `<D|K><ord2>-<tgId>-<idx2>-<purpose><leg>`, ≤36, `[A-Za-z0-9_-]`.
- `acquireSymbol(tx, { channelId, symbol, tradeId }): boolean` — атомарный `INSERT ... ON CONFLICT DO NOTHING` в `symbol_ownership` по `(channel_id, symbol)`; `false` если символ занят внутри канала.
- `openTrade(tx, {...}): { tradeId, humanRef }`, `addLeg(tx, {...})`, `closeTrade(tx, {...})`.

- [ ] **Step 1: Тесты** — `orderLinkId` детерминирован и стабилен (тот же вход → тот же ключ, ≤36 символов, dry-run префикс `D`); `acquireSymbol` второй раз по тому же `(channel, symbol)` → `false`; `openTrade` выдаёт `TR-<seq>` монотонно.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** `human_ref` и `seq` — из ОДНОГО `nextval('trade_ref_seq')` (грабля Ф0: два вызова расходятся).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): детерминированный orderLinkId, state сделок и владение символом`

---

### Task 6: ExecutionPort + DryRunAdapter

**Files:** `apps/engine/src/execution/port.ts`, `apps/engine/src/execution/dry-run.adapter.ts`, тест рядом.

**Interfaces:**
- `interface ExecutionPort { placeEntry(...), placeTpLadder(...), setStopLoss(...), closePosition(...), cancelOrder(...) }` — возвращают записи `orders`/`executions`.
- `DryRunAdapter implements ExecutionPort` — пишет строки `orders` (status сразу `filled` для market, `submitted` для limit), `executions` (симулированный fill по цене входа), обновляет `positions` (симулированная запись: size, avg_price, entry, leverage, tp/sl), НЕ звонит Bybit. Идемпотентно по `order_link_id`.

- [ ] **Step 1: Тесты** — `placeEntry` создаёт `orders`+`executions`+`positions` строку; повторный вызов с тем же `orderLinkId` (`ON CONFLICT`) не создаёт второй ордер; `placeTpLadder` из 3 целей создаёт 3 reduceOnly-ордера с разными `tp_index`.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** Порт выбирается по `EXECUTION_MODE`; в Ф1 всегда `DryRunAdapter`. Симулированный `positions.mark_price` = `avg_price` на момент открытия (реальный mark подключим в задаче 9).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): ExecutionPort и DryRunAdapter — исполнение без биржи`

---

### Task 7: Reconciler + pipeline + engine-процесс

**Files:** `apps/engine/src/reconciler.ts`, `apps/engine/src/pipeline.ts`, `apps/engine/src/main.ts`, `apps/engine/package.json`, `apps/engine/Dockerfile`, тест `apps/engine/test/pipeline.e2e.test.ts`.

**Interfaces:**
- `reconcile(parsed: ParsedResult, ctx): Decision` — в Ф1 берёт только детерминированный путь (`route === 'execute'`); `route === 'ai'` → статус `needs_review` (AI в Ф2); `noise` → `noise`; `skip` → `skipped` с reason. Назначает канонический `actionIndex`.
- `pipeline.process(message): Promise<void>` — normalize → adapter.parse → reconcile → (для каждого intent) risk → executionPort. Пишет `actions`, `parse_results`. Публикует `action.new` / `action.skipped` / `position.upsert`.
- Engine-loop: `SELECT ... FROM messages WHERE status IN ('received',...) ORDER BY channel_id, tg_message_id FOR UPDATE SKIP LOCKED LIMIT N`, обработка строго по возрастанию `tg_message_id` в пределах канала, продвижение `messages.status`.

- [ ] **Step 1: e2e-тест** — прогнать фикстуру CH1 (100 сообщений) через `pipeline` в тестовой БД: появляются `actions` с `trade_id`, `trades` с `human_ref`, `positions` для открытых сделок; символы `GRASSUSDT`/`EIGENUSDT` → `skipped: symbol_not_listed` (testnet); дельты матчатся к позициям по символу. **Повторный прогон не создаёт дублей** (уникальность `actions (message_id, action_index)` и `orders.order_link_id`).
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать** engine-процесс, loop, pipeline, reconciler. Обработка одного канала строго последовательна (advisory-lock по `channel_id`).
- [ ] **Step 4: Тест зелёный** — привести число созданных trades/actions/positions.
- [ ] **Step 5: Commit** — `feat(engine): пайплайн разбора и исполнения в dry-run`

---

### Task 8: REST Actions и Positions + WS-события

**Files:** `apps/api/src/actions/*`, `apps/api/src/positions/*`, `packages/shared/src/ws-events.ts` (+ `action.new`, `action.skipped`, `position.upsert`, `position.close`), тесты api.

**Interfaces:**
- `GET /api/actions?channel=&period=&type=&side=&q=` → `ActionRowDto[]` (Action, Pair, Summary, Trade #TR-x, Channel, Time, Method). Фильтры по research/дизайну.
- `GET /api/positions?channel=&side=&margin=&q=` → `PositionDto[]`.
- `GET /api/positions/stats` → `{ openPositions, unrealisedPnl, positionValue, marginUsed }`.
- `MessageActionDto` в `MessageDto.actions` теперь заполняется (иконка/тип/pair/tradeRef/skipped).

- [ ] **Step 1: Тесты** — после прогона фикстуры `GET /api/actions` возвращает строки с корректными типами и `#TR-x`; фильтр по `type=open` сужает; `GET /api/positions/stats` считает агрегаты; без куки → 401.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** сервисы, контроллеры, DTO. Иконки типов — маппинг из спеки §12 (`open`→trending-up/down, `close`→circle-x, `partial_tp`→target, `partial_close`→scissors, `modify_sl`→shield, `add`→circle-plus, `cancel_order`→circle-minus).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(api): REST и WS для действий и позиций`

---

### Task 9: Фронт — страница Actions

**Files:** `apps/web/src/routes/actions.tsx`, компоненты фильтров/таблицы, тест.

- [ ] **Step 1: Тест** — таблица рендерит колонки Action/Pair/Summary/Trade/Channel/Time/Method (дизайн 306–392); segmented-фильтры Channel/Period/Type/Side + поиск; клик по `Trade #TR-x` ведёт на `/positions?tr=...`; пустое состояние.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать 1:1** по `Admin.dc.html:306-392` (сегменты `segBtn` 701–706, строки таблицы, иконки типов). Данные из `GET /api/actions`. Реалтайм: `action.new` вставляет строку.
- [ ] **Step 4: Тест зелёный.**
- [ ] **Step 5: Commit** — `feat(web): страница Actions`

---

### Task 10: Фронт — страница Positions с реалтайм mark price

**Files:** `apps/web/src/routes/positions.tsx`, `apps/engine` подключение public WS Bybit для mark price, тест.

**Interfaces:**
- Engine подписывается на public `tickers.<symbol>` Bybit (доступно без ключа и в dry-run) для символов с открытыми позициями, обновляет `positions.mark_price`, `unrealised_pnl`, публикует `position.upsert` с троттлингом ~10/с.

- [ ] **Step 1: Тест** — 4 стат-карточки (Open positions, Unrealised PnL, Position value, Margin used) из `GET /api/positions/stats`; таблица позиций (Symbol/Side/Size/Entry/Mark/Liq/PnL+ROI/TP-SL/Leverage+chip/Source) по дизайну 394–475; `position.upsert` обновляет строку без перезагрузки; `?tr=#TR-x` предзаполняет поиск.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать** страницу 1:1 (дизайн 394–475), engine-подписку на public tickers, троттлинг. PnL для long/short по `(mark−entry)·size` со знаком.
- [ ] **Step 4: Тест зелёный.**
- [ ] **Step 5: Commit** — `feat(web): страница Positions с реалтайм mark price`

---

### Task 11: Реплей дампа, идемпотентность, приёмка Ф1

**Files:** `docker-compose.yml` (сервис `engine`), скрипт реплея, обновление `LOOP_STATE.md`.

- [ ] **Step 1: Добавить `engine` в compose** (`depends_on: postgres healthy`, том `./var`, одна реплика — единственный писатель).
- [ ] **Step 2: Собрать стек.** `pnpm run up`, дождаться healthy. Engine обрабатывает уже принятые сообщения канала `2088626562`.
- [ ] **Step 3: Приёмка вручную.** Открыть UI: на странице Actions появились реальные действия с `#TR-x`; на Positions — симулированные позиции с симвлами из сигналов; в таймлайне канала под сообщениями видны распознанные action-строки. Привести SQL-счётчики: `select count(*) from trades`, `from actions`, `from positions`.
- [ ] **Step 4: Идемпотентность.** Сбросить `messages.status` канала в `received` и дать engine переобработать: `select count(*) from (select message_id, action_index from actions group by 1,2 having count(*)>1)` → 0; `select count(*) from (select order_link_id from orders group by 1 having count(*)>1)` → 0.
- [ ] **Step 5: Обновить `LOOP_STATE.md`** — Ф1 выполнена, грабли.
- [ ] **Step 6: Commit** — `feat: фаза 1 — детерминированный разбор канала 2088626562 в dry-run`

---

## Definition of Done для Ф1

- Реальные сообщения канала `2088626562` превращаются в `actions` с `#TR-x`, `trades`, `trade_legs` и симулированные `positions` — без единого обращения к Bybit (кроме публичного instruments/tickers).
- Страницы Actions и Positions работают 1:1 с дизайном, обновляются в реальном времени.
- Денежная математика покрыта property-тестами: ликвидация всегда за стопом, notional в пределах потолка, qty кратно шагу.
- Повторный прогон дампа не создаёт дублей actions/orders.
- `pnpm test` и `pnpm typecheck` зелёные.

## Что осознанно не делается в Ф1

Форум `1962583820` (нужен AI+vision — Ф2), реальные ордера на бирже (Ф3), настройки канала (редактирование), история закрытых сделок с realized PnL (Ф4). `route === 'ai'` сообщения помечаются `needs_review` и в Ф1 не исполняются.
