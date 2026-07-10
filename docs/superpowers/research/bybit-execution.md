All data verified. Compiling the final report.

---

# Верификация исполнительного слоя Bybit V5 (linear) — TESTNET

**Аккаунт (живой запрос `GET /v5/account/info`):** `unifiedMarginStatus=5` → **UTA 2.0** (не pro), `marginMode=REGULAR_MARGIN` (кросс), `dcpStatus=OFF`. Кошелёк пуст: `GET /v5/account/wallet-balance accountType=UNIFIED` → `totalEquity=0`, `coin:[]`. **Позиций и ордеров нет** (`position/list settleCoin=USDT` → `[]`, `order/realtime` → `[]`). Подпись HMAC (GET: `ts+apiKey+recvWindow+queryString`, заголовки `X-BAPI-*`) — рабочая, все запросы `retCode=0`.

Ключевое следствие пустого кошелька: **live-примеры позиций/исполнений на testnet получить нельзя** (нет средств; faucet/пополнение — мутация, вне мандата). Где данные нельзя было родить вживую — помечено `[НЕ ПРОВЕРЕНО live]` и приведена схема из доков + живой хендшейк.

---

## 1. Position mode (one-way vs hedge)

- **Текущий режим — one-way.** `GET /v5/position/list category=linear symbol=BTCUSDT` вернул единственную запись с `positionIdx=0` (в hedge пришли бы две: idx 1 и 2). Даже при `size=0` эндпоинт отдаёт стаб с `positionIdx=0, leverage=10, tradeMode=0` — режим/плечо/маржу можно читать без открытой позиции.
- **positionIdx:** `0` = one-way; `1` = hedge Buy; `2` = hedge Sell (подтверждено доками trading-stop/position).
- **Переключение:** `POST /v5/position/switch-mode`, `mode=0` (one-way) / `mode=3` (hedge). Приоритет `symbol > coin > default`. Блокируется при наличии позиции/ордера по символу. UTA 2.0 официально «Support one-way & hedge-mode» для USDT-перпов ([switch-mode doc](https://bybit-exchange.github.io/docs/v5/position/position-mode)).
- **Совместимость с «один символ — один канал»:** **полностью совместимо с one-way.** Одновременно по символу живёт максимум одна нетто-позиция — это и есть модель «владельца символа». **Hedge не нужен** и даже вреден (усложнит реконсиляцию: две записи на символ, positionIdx в каждом вызове). Рекомендация: явно выставить `mode=0` на старте и работать в one-way.

## 2. Установка плеча (`POST /v5/position/set-leverage`)

- Параметры: `category, symbol, buyLeverage, sellLeverage`. В one-way **`buyLeverage` обязан равняться `sellLeverage`** ([leverage doc](https://bybit-exchange.github.io/docs/v5/position/leverage)).
- **Повторная установка того же плеча → `retCode=110043 "Set leverage has not been modified"`** (подтверждено error-doc + ccxt/pybit issues). Это НЕ ошибка — трактовать как идемпотентный успех: **добавить 110043 в whitelist игнорируемых кодов.**
- Работает ли при открытой позиции: да, плечо на Bybit меняется при открытой позиции (пересчитывает IM). `[НЕ ПРОВЕРЕНО live — мутация под запретом]`.
- **Idempotency:** set-leverage сам по себе идемпотентен (110043 на no-op). Практика: перед открытием всегда вызывать set-leverage, 110043 глотать. Текущее плечо для сравнения читается из `position/list.leverage` (сейчас `"10"`).

## 3. Маржа: isolated vs cross — КРИТИЧНО для UNIFIED

- **В UTA маржинальный режим — АККАУНТ-УРОВНЕВЫЙ, НЕ по-символьный.** Дословно (Bybit HC «Differences Between the Margin Modes Under UTA»): *«The selected margin mode applies to your entire account, meaning you cannot choose different margin modes for individual trading pairs.»* Три режима на весь аккаунт: `REGULAR_MARGIN` (cross), `ISOLATED_MARGIN`, `PORTFOLIO_MARGIN`. Наш аккаунт сейчас `REGULAR_MARGIN` → **все linear-позиции кросс.**
- Переключение: **`POST /v5/account/set-margin-mode`** (`setMarginMode=ISOLATED_MARGIN|REGULAR_MARGIN|PORTFOLIO_MARGIN`). Старый `POST /v5/position/switch-isolated` для UTA-linear **не применяется** (URL доки `position/cross-isolate` отдаёт 404 — это legacy для classic/inverse).
- Переход в ISOLATED требует: нет опционных позиций/ордеров, нет spot-margin/займов, mark-price существующих позиций не хуже их liq после перехода. То есть переключать «на лету» под каждый сигнал нельзя.
- **Вывод по per-channel «Allow cross margin»:** технически **невозможно** реализовать как биржевой режим маржи в UNIFIED — это один переключатель на весь аккаунт. Варианты для продукта:
  1. Зафиксировать один режим на аккаунт (рекомендую cross/REGULAR — текущий), а per-channel тумблер трактовать как **логический риск-параметр** (напр., лимит доли equity на канал), не как биржевой margin mode.
  2. Если нужна настоящая изоляция капитала между каналами — **разные суб-аккаунты/API-ключи на канал** (у каждого своя equity и свой режим). Это единственный способ дать каналам независимую маржу в UTA.
- ⚠️ В **cross** liq-цена позиции зависит от equity всего аккаунта (см. §6) — «изоляция символ↔канал» на уровне риска не даёт изоляции ликвидации: просадка по одному символу двигает liq остальных.

## 4. TP-лесенка

Механика `POST /v5/position/trading-stop` ([doc](https://bybit-exchange.github.io/docs/v5/position/trading-stop)):
- `tpslMode`: `Full` (весь размер) / `Partial` (частичный). Для лесенки — `Partial`.
- **Один вызов = один уровень TP.** Чтобы поставить 3 цели → 3 вызова, в каждом `takeProfit=<цена_i>` + `tpSize=<доля_i>`, `positionIdx=0`. Каждый вызов создаёт отдельный условный TP-ордер.
- ⚠️ Ограничение: *«the value of tpSize and slSize must equal»* — если в ОДНОМ вызове передать и `tpSize`, и `slSize`, они обязаны совпасть. Поэтому **SL ставить отдельным вызовом** (`stopLoss` + `slSize`=полный размер), не смешивая с частичными TP.
- `tpOrderType`: `Market`(деф.)/`Limit` (при `Limit` нужен `tpLimitPrice`); `tpTriggerBy`: по умолчанию `LastPrice`.
- Сумма `tpSize` по всем уровням не должна превышать размер позиции; при равных долях по 3 целям — округлять каждую до `qtyStep` и последнюю добивать остатком (иначе rounding-дефицит оставит «хвост» без TP).
- **Что показывает `GET /v5/position/list` при Partial:** поля `takeProfit`/`stopLoss` в позиции **не отражают всю лесенку** (это единичные поля, релевантны для `Full`). Level-ордера лесенки видны как условные ордера в **`GET /v5/order/realtime`** (со `stopOrderType=PartialTakeProfit`/`PartialStopLoss`). `[схема из доков; live не воспроизвести — нет позиций]`.

**Сравнение с reduceOnly limit-ордерами** (`POST /v5/order/create`, `reduceOnly=true`, `timeInForce=GTC`):
| Критерий | trading-stop Partial | reduceOnly limit |
|---|---|---|
| Кол-во уровней | ограничено, вводится по одному | произвольное |
| Наблюдаемость состояния | частичная (order/realtime, не position/list) | **полная** (каждый ордер в order/realtime) |
| Идемпотентность | нет своего `orderLinkId` на уровень | **есть `orderLinkId` на каждый TP** |
| Квирки размеров | «tpSize=slSize», доли/остатки | нет |
| Триггер-тип/частичное закрытие | как задумано биржей | через `execution.closedSize` |

**Рекомендация: reduceOnly limit-ордера для TP-лесенки** — надёжнее для копитрейд-бота (полная наблюдаемость + `orderLinkId` идемпотентность + произвольное число целей). SL держать отдельно через trading-stop `Full` (гарантированный market-close на весь остаток) — это исключает риск «недокрытого» остатка, если reduceOnly-лимитки не сматчились.

## 5. SL: постановка и перенос / безубыток

- Постановка: `trading-stop` `stopLoss=<цена>`, `slTriggerBy` (деф. `LastPrice`; можно `MarkPrice`), `positionIdx=0`. Для `Full` SL закрывает весь остаток маркетом при триггере.
- **Перенос / «стоп в б/у»**: повторный `trading-stop` с новым `stopLoss`. Безубыток = `stopLoss ≈ avgPrice` позиции (`position/list.avgPrice`); на практике сдвигать на несколько тиков в сторону прибыли, чтобы покрыть комиссии закрытия (`~0.055%` taker) — иначе «б/у» уходит в лёгкий минус.
- Снятие SL: `stopLoss="0"`.
- **Влияние на частичные TP:** SL и TP-ордера независимы — перенос SL не трогает выставленные TP (ни в trading-stop-варианте, ни тем более в reduceOnly-варианте). При Partial держите `slSize` = текущему остатку позиции: после срабатывания части TP размер позиции уменьшился, и `Full`-SL автоматически покрывает новый остаток; при явном `slSize` его надо пересчитывать после каждого частичного закрытия.

## 6. Формула liq price + максимальное безопасное плечо

Источник: Bybit HC «Liquidation Price Calculation under Isolated Mode (UTA)». Общая форма (isolated):
```
IM = PositionValue * IMR,   IMR = 1/leverage           # initial margin
MM = PositionValue * MMR - mmDeduction (+ closeFee)     # maintenance margin
Long:  LiqPrice = Entry - (IM - MM)/Qty - ExtraMargin/Qty
Short: LiqPrice = Entry + (IM - MM)/Qty + ExtraMargin/Qty
```
Подставляя `PositionValue = Entry*Qty`, `ExtraMargin=0`, tier-1 `mmDeduction=0`:
```
Long:  LiqPrice = Entry * (1 - 1/lev + MMR)
Short: LiqPrice = Entry * (1 + 1/lev - MMR)
```
**Численная проверка (пример из доков):** Entry=70000, 1 BTC, lev=10, MMR=0.5% → Short = 70000·(1+0.1−0.005)=**76650** ✓ (совпало с примером Bybit). Long = 70000·0.905 = 63350.

**MMR/tiers — живые данные `GET /v5/market/risk-limit`:** BTCUSDT tier1 `riskLimitValue=2 000 000`, `MMR=0.005`, `IMR=0.01`, `mmDeduction=""`(0); SOLUSDT tier1 `50 000`, `MMR=0.005`. `mmDeduction` появляется со 2-го тира (BTC tier2=1200, tier3=3020...) по формуле `mmDeduct_n = riskLimit_{n-1}·(MMR_n − MMR_{n-1}) + mmDeduct_{n-1}`. Розничные объёмы копитрейда целиком в tier1 → **MMR плоский, mmDeduction=0**.

**Максимальное безопасное плечо (чтобы SL сработал раньше ликвидации), вывод:**
Требуем для long `LiqPrice ≤ SL`, для short `LiqPrice ≥ SL`. Пусть `d = |Entry − SL| / Entry` (stopDistance). Обе стороны дают один результат:
```
1/lev + MMR ≥ d           →           lev_max_safe = 1 / (d + MMR + buf)
```
`buf` — буфер (напр. 0.003…0.01) на комиссии/проскальз./переход тиров. Финальное плечо:
```
lev = clamp( floor_to(leverageStep,  1/(d + MMR + buf)),  1,  min(channelMaxLev, instrMaxLev) )
```
**Проверка на дампе (LIT short, ch-2088626562 #2796):** entry≈1.5004 (середина 1.5273–1.4735), SL=1.7137 → d=0.1422; MMR≈0.005, buf=0.005 → lev_max=1/0.1522≈**6.57×** → floor→6×. Разумно.

**Cross:** формула выше — для isolated. В cross buffer = вся доступная equity аккаунта, поэтому фактический LiqPrice **дальше** от entry (безопаснее) при том же плече, НО зависит от суммарного uPnL всех позиций и «плавает». Для выбора плеча используйте **isolated-формулу как консервативную нижнюю границу** (isolated даёт ближайший к entry liq) — она безопасна и для cross. Точный cross-liq в реальном времени берите из `position/list.liqPrice` / WS `position.liqPrice`, не считайте формулой.

## 7. Округления и таблица символов

Общие правила (все целевые символы: `minNotionalValue=5 USDT`):
- **qty:** округлять **вниз (floor) до `qtyStep`**; затем проверить `qty ≥ minOrderQty` и `qty·price ≥ 5 USDT` (иначе `retCode 110017` «truncated to zero» / отклонение по minNotional). Для reduceOnly-TP последнюю долю добивать остатком.
- **price:** приводить к кратному `tickSize` (`round`/`floor` к тику; для лимит-входа long — floor даёт не-хуже цену, для short-входа — ceil). Некратная тику цена → `retCode 10001`.
- **leverage:** кратно `leverageStep=0.01`, `1 ≤ lev ≤ maxLeverage`.
- ⚠️ **`minNotional=5`**: при малой equity fixed-fractional-сайзинг может дать notional < 5 → **Skipped «below min notional»**. Заложить проверку.

**Таблица «тикер из сообщения → символ Bybit»** (qtyStep/minQty/tick — живой `instruments-info`; maxLev по TN и MN, различия выделены):

| Тикер (msg) | Символ Bybit | TN | MN | qtyStep | minQty | tickSize | maxLev MN | maxLev TN |
|---|---|:--:|:--:|---|---|---|--:|--:|
| BTC | BTCUSDT | ✅ | ✅ | 0.001 | 0.001 | 0.10 | 100 | 100 |
| SOL | SOLUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.010 | 100 | 100 |
| GRASS | GRASSUSDT | ❌ | ✅ | 1 | 1 | 0.00001 | 25 | — |
| EIGEN | EIGENUSDT | ❌ | ✅ | 1 | 1 | 0.00001 | 50 | — |
| TIA | TIAUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.0001 | 50 | 50 |
| APT | APTUSDT | ✅ | ✅ | 0.01 | 0.01 | 0.0001 | **50** | **25** |
| XRP | XRPUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.0001 | 100 | 100 |
| VVV | VVVUSDT | ✅ | ✅ | 0.01 | 0.01 | 0.0010 | 20 | 20 |
| MET | METUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.00001 | 25 | 25 |
| RE | REUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 20 | 20 |
| BEAT | BEATUSDT | ✅ | ✅ | 1 | 1 | 0.00010 | 25 | 25 |
| PUMPFUN | PUMPFUNUSDT | ✅ | ✅ | 100 | 100 | 0.0000001 | 75 | 75 |
| DOGE | DOGEUSDT | ✅ | ✅ | 1 | 1 | 0.00001 | 75 | 75 |
| LIT | LITUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.0001 | **25** | **50** |
| GENIUS | GENIUSUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 25 | 25 |
| BB | BBUSDT | ✅ | ✅ | 1 | 1 | 0.00001 | 25 | 25 |
| ONDO | ONDOUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 50 | 50 |
| PENDLE | PENDLEUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 50 | 50 |
| AERO | AEROUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 25 | 25 |
| VIRTUAL | VIRTUALUSDT | ✅ | ✅ | 1 | 1 | 0.0001 | 50 | 50 |
| JUP | JUPUSDT | ✅ | ✅ | 1 | 1 | 0.00001 | 50 | 50 |
| MYX | MYXUSDT | ✅ | ✅ | 1 | 1 | 0.00001 | 12.5 | 12.5 |
| ALICE | ALICEUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.00001 | 20 | 20 |
| DEXE | DEXEUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.0010 | 20 | 20 |
| DYDX | DYDXUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.00001 | 50 | 50 |
| ENA | ENAUSDT | ✅ | ✅ | 1 | 1 | 0.00001 | **50** | **25** |
| LDO | LDOUSDT | ✅ | ✅ | 0.1 | 0.1 | 0.0001 | 50 | 50 |

- **НЕ существуют на testnet** (только mainnet): **GRASSUSDT, EIGENUSDT** (на TN есть лишь `EIGENPERP` — USDC-settled, другой контракт). Сломают e2e именно на testnet.
- **maxLev расходится TN↔MN:** APT (50/25), ENA (50/25), LIT (25/50). ⇒ **Плечо clamp'ить по `instruments-info` ТОГО окружения, где реально торгуем** (на testnet — по testnet-значениям), не по mainnet.
- **1000-префикс:** нужен для мем-коинов. Проверено: `1000PEPEUSDT`(TN+MN, step100, tick0.0000010), `1000BONKUSDT`, `1000FLOKIUSDT`, `1000CATUSDT`, `1000000BABYDOGEUSDT`, `1000000MOGUSDT`, `10000SATSUSDT` и т.д. на обоих. Голых `PEPEUSDT/BONKUSDT/SHIBUSDT/FLOKIUSDT` **нет** ни на TN, ни на MN. В дампе таких пока нет, но резолвер тикеров обязан пробовать `1000<X>`/`1000000<X>` фолбэк. `PUMP` из «pump.fun» → это `PUMPFUNUSDT` (голого `PUMPUSDT` нет; есть `PUMPBTCUSDT` — другой актив, не путать).

## 8. Идемпотентность (`orderLinkId`)

- Правила ([create-order doc](https://bybit-exchange.github.io/docs/v5/order/create-order)): **max 36 символов**, `[A-Za-z0-9_-]`, **должен быть уникальным** для всех типов. (В issue-трекерах встречается лимит «45» — но документированная граница 36; держитесь ≤36.)
- **Дубликат → `retCode 110072` «OrderLinkedID is duplicate»** (derivatives; на spot — 110141). Это и есть механизм защиты от дублей.
- TTL идентификатора: `orderLinkId` держится «горячим» пока ордер активен + ограниченное время в истории; надёжно НЕ переиспользовать вовсе.
- **Гарантия от дубля при реконнекте/ретрае:** генерировать **детерминированный** `orderLinkId` из бизнес-события, а не случайный. Схема: `TR<tradeId>-<action>-<seq>` (напр. `TR142-ENTRY-0`, `TR142-TP1`, `TR142-ADD-2`). При ретрае тот же ключ → биржа вернёт 110072, который трактуем как «уже принято» (идемпотентный успех). Так реконнект/повтор физически не создаст второй ордер.

## 9. Отмена лимиток

- Одиночная: `POST /v5/order/cancel` — `category=linear` + `symbol` + (`orderId` **или** `orderLinkId`).
- Массовая: `POST /v5/order/cancel-all` — `category=linear` + `symbol` (или `settleCoin=USDT`, или `baseCoin`).
- Список активных: **`GET /v5/order/realtime`** `category=linear` (`settleCoin=USDT` / `symbol`, `openOnly=0`) — проверено живьём (сейчас `[]`). Отсюда же берутся неисполненные entry-лимитки для **TTL-отмены** (по `createdTime`) и висящие reduceOnly-TP.

## 10. Rate limits V5

- **Живые заголовки** на GET-ах (`account/info`, `wallet-balance`, `position/list`, `order/realtime`): `X-Bapi-Limit: 50`, `X-Bapi-Limit-Status: 49` (осталось), `X-Bapi-Limit-Reset-Timestamp`. ⇒ **приватные GET = 50/s на эндпоинт/UID.**
- Мутирующие (create/amend/cancel/set-leverage/trading-stop): документированный дефолт **≈10/s** на эндпоинт/UID (для UTA-linear часть источников даёт 20/s; наш аккаунт UTA2.0 non-pro). `[не тестировано live — мутации под запретом]`. Апгрейд лимитов — по заявке.
- Заголовки: `X-Bapi-Limit` (лимит), `X-Bapi-Limit-Status` (остаток), `X-Bapi-Limit-Reset-Timestamp` (когда сбросится).
- **`10006`** = превышен API rate limit (per-UID, rolling 1s). **`10018`** = превышен **IP** rate limit. Обработка: не ретраить сразу; читать `X-Bapi-Limit-Reset-Timestamp`, ждать до сброса, экспоненциальный backoff; глобальный limiter (токен-бакет) на клиенте под 50/s GET и ~5–8/s мутаций с запасом.

## 11. WS private — живой хендшейк + схемы

`wss://stream-testnet.bybit.com/v5/private`. **Проверено вживую:** `op:auth` (`expires=now+10s`, `sign=HMAC(secret,"GET/realtime"+expires)`) → `{"success":true,"op":"auth"}`; затем `subscribe [position.linear, order.linear, execution.linear, wallet]` → `{"success":true,"op":"subscribe"}`. Data-пуши не пришли — **позиций/ордеров нет** (пустой аккаунт), поэтому payload'ы ниже — из доков `[НЕ ПРОВЕРЕНО live]`.

`position.linear` (пример из доков):
```json
{"topic":"position","data":[{"positionIdx":0,"symbol":"BTCUSDT","side":"Buy","size":"0.5",
"entryPrice":"...","leverage":"10","positionValue":"...","markPrice":"...","liqPrice":"...",
"takeProfit":"0","stopLoss":"0","tpslMode":"Full","unrealisedPnl":"...","curRealisedPnl":"...",
"cumRealisedPnl":"...","positionStatus":"Normal","seq":8327597863,
"createdTime":"...","updatedTime":"...","category":"linear"}]}
```
`execution.linear` (доки) — ключ для отличия частичного/полного закрытия:
```json
{"topic":"execution","data":[{"category":"linear","symbol":"BTCUSDT",
"closedSize":"0.5","execQty":"0.5","execPrice":"95900.1","leavesQty":"0",
"side":"Sell","orderId":"...","orderLinkId":"...","execType":"Trade","execPnl":"...","isMaker":false}]}
```
- **Частичное vs полное закрытие:** событие относится к закрытию если `closedSize>0`. **Полное** закрытие → после исполнения `position size → 0` и последнее `execution` имеет `leavesQty="0"` при отсутствии остатка позиции; **частичное** → `closedSize < размер_позиции_до`, позиция остаётся с ненулевым size. Надёжнее опираться на пуш `position` (size стал 0 ⇒ полностью закрыто; `positionStatus`), а `execution.closedSize`/`orderLinkId` использовать для атрибуции к конкретной цели лесенки (`TR142-TP1` и т.п.).
- `order.linear` — статусы entry/TP-лимиток (`orderStatus`, `orderLinkId`, `cumExecQty`); `wallet` — изменения equity/баланса.

## 12. WS public `tickers.<symbol>`

`wss://stream-testnet.bybit.com/v5/public/linear`. **Проверено вживую (BTCUSDT):** первый пуш `type:"snapshot"` (полный набор), далее `type:"delta"` **каждые ~100–300 мс, только изменённые поля**. `markPrice` присутствует в большинстве дельт, но **не в каждой** (напр. пришла дельта только с `ask1Price`). Живой фрагмент:
```
snapshot: markPrice=62850.70 indexPrice=63236.75 lastPrice=62835.60 fundingRate=-0.005
delta:    markPrice=62850.55 indexPrice=63236.80
delta:    ask1Price=62835.70            ← markPrice отсутствует
```
- **Вывод:** `tickers.<symbol>` достаточен для UI-uPnL/ROI: `uPnL = (markPrice − entry)·size·dir`, `ROI = uPnL / positionIM`. НО обязательно **мержить дельты поверх snapshot** (хранить последний markPrice; дельта без поля = «не изменилось»). Частота 100 мс с запасом для UI.
- **markPrice** (не lastPrice) — правильная база для uPnL и совпадает с тем, что использует биржа для MM/liq (после апдейта margin-калькуляции 02.09.2025 MM считается по mark). Для точных цифр «как на бирже» держите и `position` stream (`unrealisedPnl`, `liqPrice` уже посчитаны биржей) — но для лёгкого UI хватит tickers.

## 13. Testnet-специфика (подводные камни e2e)

- **Разный листинг:** `GRASSUSDT`, `EIGENUSDT` **отсутствуют на testnet** → сигналы по ним на testnet → Skipped/ошибка резолва. На mainnet есть. (Всего linear: TN=708, MN=720.)
- **Разный maxLeverage:** APT 25(TN)/50(MN), ENA 25/50, LIT 50(TN)/25(MN) — clamp по окружению исполнения.
- **Пустой кошелёк** нашего testnet-аккаунта (`totalEquity=0`) → сейчас **любой live-ордер отклонится по балансу** (`110012/110045`). Для e2e нужен testnet-faucet (`POST /v5/account/... request-demo-funds` или UI-фосет) — это мутация, вне текущего мандата; выполнит владелец перед прогоном.
- Ликвидность/`markPrice` на testnet тонкие → возможны рваные проскальзывания, странный fundingRate (видел `-0.005` = cap). Для проверки логики ок, для оценки исполнения — нет.
- Хосты строго разделены: REST `api-testnet.bybit.com`, WS `stream-testnet.bybit.com`. Ключи testnet ≠ mainnet.
- Символы с суффиксом `PERP` (EIGENPERP, PUMPFUNPERP) — **USDC-settled**, НЕ попадают в `settleCoin=USDT` выборки; не путать резолвером с `...USDT`.

## 14. Реконсиляция #TR-x ↔ биржевые позиции

- В `position/list`/`order/realtime` **нет нашего `#TR-x`** — связь держим через **`orderLinkId`** (§8: префикс `TR<id>-...`). Это единственный сквозной ключ через рестарт.
- **Позиция не имеет orderLinkId** (это агрегат). Но по правилу «один символ — один канал/сделка» **`symbol` + `positionIdx=0` однозначно = текущая открытая #TR-x** для этого символа в моменте. Маппинг `symbol → activeTradeId` восстанавливаем из своей БД.
- **Поля для реконсиляции после рестарта:**
  - `GET /v5/position/list settleCoin=USDT` → `symbol, side, size, avgPrice, leverage, tradeMode, liqPrice, positionStatus, createdTime, updatedTime, seq`. `size>0` ⇒ сделка жива; `createdTime` сопоставить с временем нашего Open (защита от «чужой» позиции); `updatedTime`/`seq` — детект изменений и порядок относительно WS (seq монотонно растёт, синхронизирует REST-снапшот и WS-дельты).
  - `GET /v5/order/realtime` → незакрытые entry-лимитки и reduceOnly-TP по `orderLinkId` (восстановить, какие цели/доливки ещё висят; TTL-отмена по `createdTime`).
  - `GET /v5/order/history` + `GET /v5/execution/list` → закрытые/исполненные, атрибуция филлов к целям по `orderLinkId` и `closedSize`, расчёт realizedPnL.
- **Процедура старта бота:** (1) `position/list` — что реально открыто; (2) `order/realtime` — что висит; (3) слить с локальным журналом #TR-x по `orderLinkId`/`symbol`; (4) если биржа рассинхронна с журналом (позиция есть, а TR закрыт, или наоборот) — единый источник истины = биржа, журнал чинится по ней; (5) переподписать WS `position/order/execution` для дельт, используя `seq` как водяной знак.

---

### Артефакты верификации (в `/private/tmp/.../scratchpad/`)
`by.py` (подписанный REST-клиент), `ws.py` (raw-WS клиент, живой auth+tickers), `instr_testnet_p1.json` (708 linear TN), `instr_mainnet.json` (720 linear MN).

**Сводка непроверяемого live (пустой testnet-кошелёк / запрет мутаций):** реальные data-пуши `position/order/execution` (§11), поведение set-leverage при открытой позиции (§2), фактическое отклонение по minNotional/дублю (§7,§8), точные rate-limit числа для create/cancel (§10). Всё остальное подтверждено живыми запросами или официальными доками (ссылки в тексте).