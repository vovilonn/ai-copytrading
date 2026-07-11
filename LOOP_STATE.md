# LOOP_STATE

## Goal

Ф3 задача 6 — переключение с Bybit testnet на DEMO TRADING (заказчик сменил ключи, баланс
~165k USDT). Testnet блокировал ордера regulatory-кодом 10024; demo торгует реальными рыночными
ценами виртуальным балансом — ордера проходят. Добавить окружение `demo` в код, прогнать e2e
(задача 6 Ф3) на demo с реальными ордерами, приёмку UI и отказоустойчивость.

## Status

**ЗАВЕРШЁН.**

- [x] `packages/shared/src/domain.ts` — `Network = 'testnet' | 'mainnet' | 'demo'`.
- [x] `apps/api/src/db/migrations/005_demo_network.ts` — `ALTER TYPE net_t ADD VALUE 'demo'`
      (instruments.network — PRIMARY KEY (symbol, network), иначе refresh() на demo падал бы).
- [x] `apps/api/src/db/database.ts` — тип колонки `instruments.network` расширен на `'demo'`.
- [x] `apps/api/src/config/config.schema.ts` — `BYBIT_NETWORK` enum + `AppConfig.bybitNetwork`
      принимают `'demo'`.
- [x] `apps/engine/src/bybit/rest-client.ts` — `HOSTS.demo = 'https://api-demo.bybit.com'`
      (экспортирован `HOSTS` — переиспользован live-e2e.test.ts, DRY).
- [x] `apps/engine/src/bybit/private-ws.ts` — `WS_HOSTS.demo = 'wss://stream-demo.bybit.com/v5/private'`.
- [x] `apps/api/src/instruments/bybit-client.ts` — `HOSTS.demo` для публичных market-эндпоинтов.
- [x] `apps/engine/src/market-data/tickers-feed.ts` — `WS_HOSTS.demo` = MAINNET public WS
      (`wss://stream.bybit.com/v5/public/linear`) — **грабли**: у demo НЕТ собственного публичного
      WS (`stream-demo.bybit.com/v5/public/linear` не работает, проверено вживую при подготовке
      задачи). Demo торгует по реальным рыночным ценам — mainnet public tickers дают корректный
      mark price для demo-позиций.
- [x] `.env.example` — комментарий `BYBIT_NETWORK` обновлён (`testnet | demo | mainnet` + пояснение
      про отсутствие публичного WS у demo).
- [x] `apps/engine/test/live-e2e.test.ts` — сеть резолвится в `'demo' | 'testnet'` (не `'mainnet'`,
      явный отказ на mainnet — защита от несчастного случая), `fetchPublicMarkPrice` использует
      `HOSTS[network]` вместо хардкода testnet-хоста.

### Задача 2: instruments refresh на demo

`InstrumentsService.refresh()` на `BYBIT_NETWORK=demo` (после рестарта api-контейнера с новым
образом) наполнил **913 инструментов** (`network='demo'`), `SOLUSDT`: `status=Trading`,
`mmr=0.005000`. testnet параллельно остался нетронут (969 строк) — раздельные PK (symbol,network).

### Задача 3: живой e2e на demo (`BYBIT_LIVE_TESTS=1 pnpm --filter engine test live-e2e`)

Все 6 шагов прошли РЕАЛЬНЫМИ ордерами на demo (SOLUSDT, qty=0.2, notional~$15.6):
вход market+атомарный SL → идемпотентность (110072) → TP-лесенка (2 reduceOnly) → перенос SL →
частичное закрытие → полное закрытие + cancel-all. CLEANUP оставил аккаунт чистым.

Один найденный и починенный баг тестовой инфраструктуры: `GET /v5/execution/list` на demo
пишется в биржевой журнал с заметно бОльшей задержкой, чем на testnet — фиксированный
`sleep(2000)` возвращал пустой список сразу после исполнения. Добавлен `waitForExecutions()`
(поллинг до 15с вместо гадания с ещё одним фиксированным таймаутом) — тест зелёный, 6/6.

### Задача 4/5: приёмка UI + отказоустойчивость (совмещены — один живой прогон движка)

При живом прогоне (`EXECUTION_MODE=live`, `BYBIT_NETWORK=demo`) найдены и починены ДВА реальных
бага в `apps/engine/src/bybit/private-ws.ts` (не тестовая обвязка — продовый код синка позиций),
оба — за пределами периметра исходного брифа задачи 6, но блокировали её приёмочный критерий
(«UI Positions: реальная позиция, mark/PnL/liq из приватного WS живые») и требование задачи 5
(«приватный WS position size→0 → движок реагирует»):

1. **Водяной знак `bybit_seq` отбрасывал ЛЕГИТИМНЫЕ повторные пуши.** Bybit НЕ бампает `seq`
   позиции на `position/trading-stop` (перенос SL/TP без исполнения) — только на реальных
   исполнениях. Старый `push.seq <= current.bybit_seq` трактовал повторный пуш с ТЕМ ЖЕ seq
   (другой stopLoss, тот же seq) как "не новее" и отбрасывал НАВСЕГДА — `positions.stop_loss`
   в UI замирал на значении входа. Исправлено на строгое `<` (отбраковывает только настоящий
   реордеринг, пропускает повтор с тем же seq). Тест: "пуш с ТЕМ ЖЕ seq... -> всё равно
   применяется".
2. **`toPositionPush` ронял ЛЮБОЙ пуш закрытия позиции в null.** Bybit шлёт финальный пуш
   `position size→0` с `side=""` (пустая строка — НЕ 'None', вопреки старому комментарию в коде).
   `asNonEmptyString(o.side)` трактовал '' как "поле отсутствует" -> весь объект парсился в null ->
   `applyPositionPush` НИКОГДА не вызывался для события закрытия -> `closeTrade`/`releaseSymbol`/
   `cancelAll` (R8) не срабатывали по WS вовсе. Единственным путём, которым закрытие вообще
   долетало до журнала, была периодическая `reconcileOnStart` (раз в 10 мин) — то есть
   отказоустойчивость задачи 5 БЕЗ этого фикса не работала бы вживую (только с 10-минутной
   задержкой через REST-реконсиляцию, не через WS). Новая `asStringField` (принимает '' как
   значимое значение) — фикс. Тесты: unit на `toPositionPush(side:'')`, и e2e на сыром фрейме
   `position.linear` с `side:"", size:"0"` через `BybitPrivateWs.handleMessage`.

После обоих фиксов и рестарта движка: живой перенос SL (REST `trading-stop`) корректно долетел
до `positions.stop_loss` в БД/UI за секунды; ручное закрытие позиции через REST
(`cancelAll` + `reduceOnly` market) → приватный WS `position size→0` → корректно закрыл `TR-1204`,
освободил `symbol_ownership`, обнулил `positions.size` — **без необходимости ждать 10-минутную
реконсиляцию**.

Скриншот `/tmp/p3-demo-positions.png` — снят ДО ручного закрытия (после фикса #1, в процессе
проверки фикса #2): SOLUSDT LONG, size=0.1, entry=78.38, mark=78.159 (живой), SL=60 (перенесённый
живьём), leverage=8.69x, источник «Торговый канал Олега Артемьева #TR-1204».

### Побочные наблюдения (НЕ исправлялись — вне периметра, см. "Список сомнений" отчёта)

- `executions`/`orders` (E0/S0 конкретно этой сделки) — `order_id`/`trade_id`/`leg_id` не
  атрибутированы (NULL) для первого исполнения нового ордера: WS execution/order-пуш иногда
  долетает БЫСТРЕЕ, чем коммитится собственная транзакция pipeline, создающая строку `orders` —
  `applyExecutionPush`/`applyOrderPush` не находят её по `order_link_id` в этот момент, атрибуция
  теряется НАВСЕГДА (bybit_exec_id уникален, повтора не будет). Структурная гонка транзакций,
  не однострочный фикс — не чинилась в этом лупе, см. отчёт.
- `apps/api/test/instruments.e2e.test.ts` — тест "GRASSUSDT известен, но не торгуется" читает
  `config.bybitNetwork` из `.env` (=`demo`) и полагается на testnet-специфичный факт (GRASSUSDT
  делистнут на testnet, но `Trading` на demo, подтверждено вживую) — падает НЕ из-за моих
  изменений, а из-за того, что `.env` теперь всегда указывает demo. Вне периметра задачи
  («`pnpm --filter engine test` + `pnpm typecheck` зелёные» — про api тест речи нет).
- `[engine] рефреш equity: BybitApiError retCode=10002` — единичные всплески расхождения
  `req_timestamp`/`server_timestamp` на 5-12с при равных local/server clock (проверено `date -u`
  и `/v5/market/time`) — не диагностировано до конца (не блокирует: следующий 30с-тик рефреша
  equity успешен).

## Проверка (зелёный прогон перед коммитом)

- `pnpm --filter engine test` (без `BYBIT_LIVE_TESTS`) — **355 passed, 18 skipped** (было 352/18;
  +3 новых теста в bybit-private-ws.test.ts: same-seq пуш, side="" парсинг, e2e сырой фрейм
  закрытия).
- `pnpm typecheck` — 6/6 пакетов зелёные.
- `BYBIT_LIVE_TESTS=1 pnpm --filter engine test live-e2e` — 6/6 passed на demo, реальные ордера,
  CLEANUP подтверждён (position.size=0, openOrders=0).
- Demo-аккаунт ПОСЛЕ всего (задачи 2-5): 0 позиций, 0 активных ордеров, totalEquity≈165951.6 USDT
  (проверено REST `/v5/position/list settleCoin=USDT` + `/v5/order/realtime settleCoin=USDT` без
  фильтра по символу — весь аккаунт, не только SOLUSDT).
- `channel_settings`: оба канала (`2088626562`, `1962583820`) — `enabled=false`; `trade_size`
  канала 2088626562 возвращён к исходным `500`. Движок (docker `engine`) НЕ запущен (как и до
  начала этого лупа — `docker compose ps -a` изначально показывал его `Exited`); `.env`
  `EXECUTION_MODE=dry_run` не тронут — единственный ручной прогон `EXECUTION_MODE=live` был через
  `pnpm --filter engine exec tsx src/main.ts` с env-оверрайдом процесса, процесс остановлен
  (`SIGTERM`, "остановлен корректно").

## Не тронуто (вне периметра брифа)

`docker-compose.yml` (переопределение `EXECUTION_MODE` через env шелла уже работало, изменений не
потребовалось), `apps/tg-ingest`, `AGENTS.md` (untracked — не добавлен в коммит).
