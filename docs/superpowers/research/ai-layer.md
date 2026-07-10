All data collected. 460/460 calls succeeded. I now have the complete empirical picture. Here is the deliverable.

---

# AI‑слой копитрейдинг‑парсера — эмпирическая проверка на 200 реальных сообщениях

## 0. TL;DR (проверенные выводы)

- **Прокси ломает привычную архитектуру двух ступеней.** Прокси **молча выбрасывает поле `system`** (6297‑токеновый system → input остался 1472) → все инструкции и схему нужно класть в **user‑turn**. Прокси добавляет ~1370 токенов системного промпта Claude Code в **каждый** запрос (биллится как input). **Prompt caching РАБОТАЕТ** на user‑блоках с `cache_control` (проверено: `cache_creation 7661` → следующий вызов `cache_read 7661`; в прогонах стабильно `cache_read=4841`).
- **Двухступенчатость haiku→sonnet в этом кейсе экономически бессмысленна и теряет action’ы.** Классификатору нужны картинки (иначе не понять «2🎯»), а с картинкой haiku стоит **$3.76/1000** и caching у него не включается (min prefix 4096 > нашего 3305). Итог: two‑stage **$12.03/1000 дороже** single‑stage sonnet‑all **$11.65/1000**, и при этом haiku‑гейт **теряет ~2–4.5% реальных action’ов** (в т.ч. «стоп в б/у», спрятанный в конце `#BTC обзор`). Для требования «не упустить ни один action» — дисквалифицирует haiku как drop‑гейт.
- **Экстрактор работает.** На 30 самых сложных сообщениях 2‑го канала (symbol+тип действия): **Sonnet‑4.5 F1 0.891**, **Opus‑4.8 F1 0.922**, **Haiku‑4.5 F1 0.816**. Основные «промахи» Sonnet/Opus — это `symbol=UNKNOWN` там, где символ выводится только из СПИСКА ОТКРЫТЫХ ПОЗИЦИЙ, который я намеренно не подавал в offline‑тесте — то есть это точка reconciliation, а не ошибка модели.
- **Картинки обязательны и работают.** 0 ошибок на 460 вызовах. Символ терсных сообщений («2🎯» → XRP, «Скинул один объем» → BTC, «1🎯стоп на твх» → SOL) корректно берётся из карточки WEEX/скрина Bybit.

**Рекомендация по стеку:** одна ступень — **Sonnet‑4.5** на ВСЕ сообщения (кроме жёсткого текстового шума) с prompt‑caching, эскалация на **Opus‑4.8** при `needs_human || symbol==UNKNOWN || confidence<0.7`. Haiku — не как drop‑гейт.

Все выходные данные: `/private/tmp/aitest/out_{ch1,ch2}_{classify_haiku,extract_sonnet}.json`, `/private/tmp/aitest/gold_extract_{opus,haiku}.json`, скрипты `harness.py`, `golden.py`, `goldrun.py`.

---

## 1. Ограничения прокси (проверено curl’ом)

| Факт | Проверка | Значение |
|---|---|---|
| Эндпоинт живой, ключ не нужен | `POST /v1/messages` | ok, `msg_...` |
| Оверхед системного промпта CC | «reply OK» → `input_tokens` | **1370** на любой вызов |
| **Поле `system` игнорируется** | system‑строка 6297 tok → `input` | остался **1472** (не +6297) → **система дропается** |
| **Caching работает на message‑блоках** | 2 одинаковых вызова с `cache_control` | call1 `cache_creation=7661`, call2 `cache_read=7661` |
| Кэшируется весь prefix `tools`+CC‑system+инструкции | в прогонах | `cache_read=4841` стабильно |
| forced `tool_choice:{type:tool,name}` | 460 вызовов | 0 отказов |
| usage поля | ответ | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` |

**Следствие для дизайна:** схему инструмента и системную инструкцию класть **первым `text`‑блоком user‑turn с `cache_control:{"type":"ephemeral"}`**. Поле `system` не использовать — оно бесполезно.

---

## 2. Профиль данных (реальный дамп)

| Канал | Сообщ. | С картинками | Альбомы (groupedId) | Макс. картинка |
|---|---|---|---|---|
| ch1 `2088626562` (чистые сигналы) | 100 | 80 | 1×2 | 91.6 KB, 1280×841 |
| ch2 `1962583820/t173666` (терсный трейдер) | 100 | 47 | 1×4 (221378‑81), 1×2 | 101.6 KB, 961×1280 |

- ch1 — шаблонные сигналы: `#SYM/USDT 📈LONG · Диапазон входа: a-b$ · TP: x - y - z · SL: s$ · Риск: N%` + reply‑апдейты («первая цель, зафиксировал 50%», «стоп в б/у», «выбило по стоп‑лоссу»), «🔄 Менеджмент позиций» с 2‑3 символами, `#BTC обзор` (шум), созвоны/Zoom/OKX (шум).
- ch2 — терсный поток: `Limit long Xrp - 1.118`, `Sl btc - 64300 / Sl Eth - 1730`, `2🎯` (символ только на картинке), `Фикс половину / Стоп на твх`, `Закрываю все Лонги`, `Перезахожу в Лонги Sol Eth btc`, структурированные карточки `#SOLUSDT Long Entry price:79.3-79.4 Targets:1️⃣80.8 2️⃣82.3 3️⃣84 Stop Loss:76.7`. Ключевые маркеры: **твх** = точка входа, **б/у** = безубыток (оба → `entry_price`).

---

## 3. JSON‑схема tool‑вывода (structured output)

Один инструмент `extract_signal`, forced `tool_choice`. Правило: **LLM не считает арифметику** — вычисляемые величины отдаёт символьными маркерами. Схема покрывает все наблюдённые случаи.

```json
{
  "name": "extract_signal",
  "description": "Extract every executable trading action from a Telegram trading message (text+images). One action object per action. NEVER compute arithmetic: any price/qty to be derived (breakeven, avg entry, 'current price', 'one unit') is a symbolic marker, not a number.",
  "input_schema": {
    "type": "object", "additionalProperties": false,
    "required": ["understood","needs_human","message_type","image_used","confidence","summary","actions"],
    "properties": {
      "understood":  {"type":"boolean"},
      "needs_human": {"type":"boolean"},
      "message_type":{"type":"string","enum":["entry","add_to_position","close","close_partial","modify_sl","modify_tp","cancel_order","position_event","management_multi","commentary","noise"]},
      "image_used":  {"type":"boolean"},
      "confidence":  {"type":"number"},
      "summary":     {"type":"string"},
      "actions": {"type":"array","items":{
        "type":"object","additionalProperties":false,
        "required":["type","symbol","side","evidence_source"],
        "properties": {
          "type":  {"type":"string","enum":["open","add","close","modify_sl","modify_tp","cancel_order","tp_hit","sl_hit"]},
          "symbol":{"type":"string","description":"normalized BASEUSDT; UNKNOWN if unresolved"},
          "side":  {"type":"string","enum":["long","short","unknown"]},
          "order_type":{"type":"string","enum":["market","limit","range","na"]},
          "entry": {"type":"object","additionalProperties":false,"properties":{
            "mode":{"type":"string","enum":["market","price","range","marker","na"]},
            "price":{"type":["number","null"]},"low":{"type":["number","null"]},"high":{"type":["number","null"]},
            "marker":{"type":"string","enum":["current_price","entry_price","none"]}}},
          "stop_loss":{"type":"object","additionalProperties":false,"properties":{
            "mode":{"type":"string","enum":["price","marker","remove","na"]},
            "value":{"type":["number","null"]},
            "marker":{"type":"string","enum":["entry_price","none"]}}},
          "take_profits":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{
            "value":{"type":["number","null"]},"index":{"type":["integer","null"]},
            "marker":{"type":"string","enum":["none","current_price"]}}}},
          "tp_index":{"type":["integer","null"]},
          "close_amount":{"type":"object","additionalProperties":false,"properties":{
            "mode":{"type":"string","enum":["fraction","units","all","marker","na"]},
            "value":{"type":["number","null"]},
            "basis":{"type":"string","enum":["original","remaining","unknown"]},
            "marker":{"type":"string","enum":["one_unit","none"]}}},
          "price":{"type":"object","additionalProperties":false,"properties":{
            "mode":{"type":"string","enum":["market","price","marker","na"]},"value":{"type":["number","null"]},
            "marker":{"type":"string","enum":["current_price","entry_price","none"]}}},
          "risk_pct":{"type":["number","null"]},
          "leverage":{"type":["number","null"]},
          "evidence_source":{"type":"string","enum":["text","image","both"]},
          "evidence":{"type":"string"}
        }}}
    }}}
```

**Как схема закрывает требуемые кейсы (проверено на реале):**
- entry market/limit/range → `type=open`, `order_type∈{market,limit,range}`, `entry.mode`.
- «стоп в б/у» / «стоп на твх» → `modify_sl.mode="marker", marker="entry_price"` (число НЕ ставится). Пример 2798, 221372 — корректно.
- close_partial доля → `close_amount.mode="fraction" value=0.5/0.75 basis="original"`. «остаток/всё» → `mode="all"`. «Скинул один объем» → `mode="units" marker="one_unit"`.
- modify_tp «следующие цели 72.7, 74» → `take_profits[]`.
- add_to_position «+ limit long btc 60000» → `type=add`.
- cancel_order «лимитка не актуальна» → `type=cancel_order`.
- «убираю стопы» → `stop_loss.mode="remove"`.
- события биржи «выбило по стоп‑лоссу»/«2🎯» → `sl_hit`/`tp_hit` (не новые ордера).
- мульти‑action → несколько action‑объектов, `message_type="management_multi"`.
- commentary/noise → `actions=[]`, `understood=true`.

---

## 4. Промпты (полный текст)

### 4.1 Экстрактор — системная инструкция (подаётся ПЕРВЫМ user‑блоком с `cache_control`)

```
You parse messages from a crypto futures signal channel for an automated copy-trading bot on Bybit (category=linear, USDT perps). Output ONE tool call to extract_signal.

CORE RULE — NEVER DO ARITHMETIC. Emit symbolic markers for any value that must be computed downstream:
- "стоп в б/у" / "стоп в бу" / "безубыток" / "стоп на твх" / "стоп на точку входа" => stop_loss.mode="marker", marker="entry_price" (DO NOT output a price number).
- "по текущим" / "с текущих" / "по рынку" / "по факту" => market / current_price marker (no number).
- "фикс половину" / "50%" => close_amount mode="fraction" value=0.5. "75%" => 0.75. "остаток"/"всё" => mode="all".
- "скинул один объём" / "один объём закрыт" => close_amount mode="units" marker="one_unit".
- "убираю стоп" => stop_loss.mode="remove".

ACTION TYPES:
- open: brand-new position (new symbol/side). Includes structured cards, "Limit long Xrp - 1.118", "Sol long с текущих", "Перезахожу в Лонги Sol Eth btc" (one open per symbol).
- add: добор/доливка into an EXISTING position ("+ limit long btc 60000", "58100 extra limit long btc", "буду доливаться", "ставлю лимитку на 61000").
- close: partial or full fix ("первая цель, зафиксировал 50%", "закрываю остаток", "Фикс половину", "Закрываю все Лонги").
- modify_sl / modify_tp: change stop or targets ("Sl btc - 64300", "Следующие цели 72.7, 74", "Стоп на твх").
- cancel_order: cancel a pending limit ("лимитка не актуальна не задели").
- tp_hit / sl_hit: report an exchange event ("выбило по стоп-лоссу"=sl_hit; "первая цель есть"/"2🎯"=tp_hit). These are events, not new orders.

MULTI-SYMBOL: one message may manage several symbols ("🔄 Менеджмент позиций", "Sl btc.. Sl Eth.."). Emit one action per (symbol, intent). message_type=management_multi.

IMAGES ARE MANDATORY CONTEXT. Terse messages ("2🎯","Первые цели","Скинул один объем","Фиксану вместо первой") carry the symbol/side/price ONLY in the attached image (WEEX result card: symbol, Лонг/Шорт, leverage 10x, Цена входа, Цена маркировки; or a TradingView chart with the ticker top-left). Read the image to resolve symbol/side; set image_used=true and evidence_source="image"/"both". If symbol is still unresolved, symbol="UNKNOWN" and needs_human=true.

CONTEXT PROVIDED: the message text, its timestamp, the parent message it replies to (if any), and the channel's currently OPEN positions (to resolve which symbol a symbol-less delta refers to). Prefer an explicit symbol in text/image; else use the reply parent; else the open-positions list; else UNKNOWN.

SIDE: 📈/LONG/Лонг=long, 📉/SHORT/Шорт=short. Trader here is long-biased; a bare "фикс/стоп" on an open long => side=long.

NOISE: voice-chat announcements, Zoom links, OKX/WEEX promo, pure market reviews (#BTC обзор with no order) => message_type=commentary/noise, actions=[]. Still set understood=true.

Be exhaustive: missing an action is the worst error. If unsure whether something is an action, emit it with needs_human=true rather than dropping it.
```

### 4.2 User‑turn (переменная часть, ПОСЛЕ кэшируемого блока)

Порядок блоков: `[инструкция+схема (cache_control)]` → `[image "Image 1:"]` → `[image bytes]` → `[контекст+текст]` (картинка ДО текста — по рекомендации Anthropic).

```
Image 1 (attached to this message):
<image base64 jpeg>
t_msg=2026-06-24T20:13:11.000Z
[reply_to #221419]: Теперь ест такой таргет \n Стоп на твх
OPEN_POSITIONS: [{"sym":"SOLUSDT","side":"long","legs":2,"avg_entry":72.9,"sl":"BE","tps_left":[75,76.5]}]
MESSAGE TEXT:
На 72 \n Limit long на ту половину которую фиксировал \n Стоп убираю
```

### 4.3 Haiku‑классификатор (если всё‑таки использовать как advisory‑роутер)

```
Triage one crypto-signal Telegram message for a copy-trading bot. Decide actionable=true if it opens/adds/closes/modifies/cancels a trade OR reports a stop/target hit (even very terse: "2🎯","Фикс половину","Стоп на твх","Limit long btc 64660","выбило по стоп-лоссу"). actionable=false ONLY for: market reviews (#BTC обзор ...), voice-chat/Zoom announcements, OKX/WEEX promos, greetings, pure opinion. When unsure, choose actionable=true (a missed action is the worst outcome). Set needs_image=true when text is too terse to act without the picture.
```
Tool `classify`: `{actionable:bool, message_type:enum[signal,update,management,event,commentary,noise], needs_image:bool, confidence:number}`.

### 4.4 Как подавать открытые позиции компактно

Одна строка JSON на позицию (владелец‑канал, символ, сторона, число доборов, avg‑вход, состояние стопа, оставшиеся цели):
```json
OPEN_POSITIONS: [{"sym":"BTCUSDT","side":"long","legs":2,"avg_entry":61200,"sl":"BE","tps_left":[62000,63000],"opened":221431}]
```
~25–40 токенов/позиция. Нужна для резолюции символа терсных дельт («Стоп на твх», «Фикс половину») и различения `open` vs `add`.

---

## 5. Двухступенчатость: замеры на реале и вердикт

**Haiku‑классификатор, 200 сообщений (с картинками, caching НЕ включается — prefix 3305 < min 4096):**

| Канал | actionable=true | =false | needs_image | p50 | p95 | avg input |
|---|---|---|---|---|---|---|
| ch1 | 64 | 36 | 0 | 1796 ms | 2881 ms | 3506 |
| ch2 | 78 | 22 | 7 | 1701 ms | 2476 ms | 3104 |

Токены: input 661100, output 18048 → **$0.75 = $3.76 / 1000 сообщений**. Пропускает на sonnet **142/200 (71%)**.

**Цена ошибки классификатора (false negative = потерянный action).** Сверка `haiku.actionable=false` против `sonnet.actions≠[]`:

| Канал | TP | FP (over‑trigger) | **FN (LOST action)** | TN |
|---|---|---|---|---|
| ch1 | 64 | 0 | **2** | 34 |
| ch2 | 77 | 1 | **8** | 14 |

Разбор FN (ручная верификация каждого):

| id | текст | что потеряно | реально? |
|---|---|---|---|
| 2799 | `#BTC обзор … Остаток по #LIT ушел в б/у.` | modify_sl LIT→entry | **ДА** — action «стоп в б/у» в хвосте обзора |
| 2834 | `#BTC обзор … #TIA стоп перевел в б/у` | modify_sl TIA→entry | **ДА** |
| 221350 | `Не задело , не актуально` | cancel_order SOL | **ДА** |
| 221452 | `По битку следующие цели 63700, 64600` | modify_tp BTC | **ДА** |
| 221374 | `Вторую здесь сделаю` (img) | close/tp XRP | вероятно да |
| 221378‑81 | альбом, пустой текст | close/sl_hit/tp_hit BTC/SOL/ETH/DOGE | спорно (это «прошлые закрытия», 221384) |
| 221400 | `…На откате долился бы` | add SOL | **НЕТ** — условное, sonnet перепарсил, haiku прав |

**Вердикт по двухступенчатости:**
1. Экономика: two‑stage = **$3.76 + 0.71×$11.65 = $12.03/1000 > $11.65/1000** single‑stage sonnet‑all. Классификатор **дороже** из‑за (а) 1370‑ток CC‑системы в каждом вызове, (б) картинок ~1300 ток (нужны для терсных), (в) отсутствия кэша у haiku. Фильтрует лишь 29%.
2. Потери: haiku‑гейт теряет **~4–9 реальных action’ов на 200** (2–4.5%), в т.ч. критичные «стоп в б/у», спрятанные в конце `#BTC обзор`. **Несовместимо с требованием «100% покрытие».**

→ **Haiku‑классификатор как drop‑гейт не использовать.** Максимум — text‑only advisory‑роутер для отбрасывания жёсткого шума (Zoom/промо/приветствия), который **никогда** не дропает сообщение с `$`‑числом, `%`, `🎯`, `#TICKER` или картинкой.

---

## 6. Экстрактор Sonnet‑4.5: полные замеры (200 сообщений, с картинками)

| Метрика | ch1 | ch2 |
|---|---|---|
| Распределение `message_type` | entry27 · commentary26 · close9 · position_event8 · noise8 · close_partial7 · management_multi7 · modify_sl2 · (None6) | management_multi21 · entry17 · commentary15 · position_event14 · add10 · close8 · modify_sl7 · close_partial5 · modify_tp2 · cancel1 |
| Всего извлечено actions | 93 | 123 |
| understood=false | 0 | 1 |
| understood=true но actions=[] (шум/обзор) | 34 | 15 |
| needs_human (нужен человек) | 0 | **6** |
| Картинок приложено / image_used=true | 80 / 72 | 47 / 47 |
| Латентность p50 / p95 | 8620 / 12039 ms | 8985 / 13404 ms |
| avg fresh input / cache_read / output | 1191 / 4841 / 444 | 789 / 4841 / 519 |
| Стоимость | **$11.70 / 1000** | **$11.61 / 1000** |

Всего 460 вызовов — **0 отказов API**. `understood=false` практически нулевой → модель «понимает» ~100% сообщений (соответствует требованию заказчика). `understood=true, actions=[]` — это корректный шум (обзоры/созвоны), не потеря.

---

## 7. Golden set (30 самых сложных ch2), precision/recall извлечения actions

Ручная разметка 30 сообщений (текст + просмотр картинок), 51 эталонный action. Матч по кортежу **(base_symbol, семейство)**, семейства: ENTRY(open|add), CLOSE, MODIFY_SL(incl remove), MODIFY_TP, CANCEL, TP_HIT, SL_HIT.

| Модель | TP | FP | FN | Precision | Recall | **F1** | p50 | p95 | $/1000 |
|---|---|---|---|---|---|---|---|---|---|
| **Opus‑4.8** | 47 | 4 | 4 | 0.922 | 0.922 | **0.922** | 5292 ms | 7580 ms | 15.52 |
| **Sonnet‑4.5** | 45 | 5 | 6 | 0.900 | 0.882 | **0.891** | 8985 ms | 13404 ms | 11.61 |
| **Haiku‑4.5** | 40 | 7 | 11 | 0.851 | 0.784 | **0.816** | 2863 ms | 4477 ms | 2.04 |

**Конкретные расхождения (все модели):**

- **221420 / 221448 — `symbol=UNKNOWN`** (Sonnet и Opus). Символ выводится ТОЛЬКО из открытых позиций / цепочки reply (SOL, BTC), которую я намеренно не подавал offline. Модели корректно вернули `UNKNOWN + needs_human`, а не выдумали символ. **Это точка reconciliation, не ошибка модели** — в проде с OPEN_POSITIONS резолвится. Если исключить эти 2 сообщения, Sonnet recall → 0.94.
- **221360 «Первые цели» (img=триггер‑ордера BTC/ETH/DOGE)** — все модели дали `TP_HIT`, я разметил `MODIFY_TP`. Символы BTC/ETH/DOGE у всех верны; расхождение только в семействе (спорная разметка — на скрине висящие close‑триггеры). Не потеря.
- **221396 / 221410** — модели взяли `modify_sl(marker)`+`modify_tp`, но пропустили сопутствующий `tp_hit` («первая цель 71.27🎯» / «1🎯»). Мелкий недобор события.
- **Только Haiku:** 221404 `🛑68.2 🎯72.3,73.7,75` (reply SOL) прочитан как **ENTRY** вместо `modify_sl+modify_tp` — грубая ошибка композиции; 221448 склеил 2 добора в 1. Haiku слаб на многосоставных терсных сообщениях.

**Положительные примеры (Sonnet, схема работает):**
- LIT short (2796): `open range 1.4735–1.5273`, TP‑лесенка `[1.4428,1.3926,1.2777]`, `sl price 1.7137`, `risk 2%`, `order_type range`.
- 2798: `tp_hit #2` + `close fraction 0.75 basis=original` + `modify_sl marker=entry_price` — «второй тейк, зафиксировал 75%, стоп в б/у» разложено идеально.
- 2889: `sl_hit APT` + `close all remaining MET` (и корректно НЕ создал action для «#TIA продолжаю удерживать»).
- 221372 (image‑only): символ SOL взят из картинки, `close 0.5` + `modify_sl marker=entry_price`.
- 221375: `remove_sl SOL` + `remove_sl BTC` + `add ETH limit 1615`.

---

## 8. Рекомендация по моделям на каждую ступень (с обоснованием из замеров)

| Ступень | Модель | Обоснование (числа) |
|---|---|---|
| **Классификатор/роутер** | **не нужен как drop‑гейт**; опционально text‑only Haiku advisory | Two‑stage $12.03 > single $11.65; теряет 2–4.5% action’ов. Экономии нет. |
| **Экстрактор (основной)** | **Sonnet‑4.5** | F1 **0.891**, understood=false≈0, $11.6/1000, p95 13.4 s. Достаточен для 90%+ трафика. |
| **Экстрактор (эскалация)** | **Opus‑4.8** при `needs_human=true` OR `symbol==UNKNOWN` OR `confidence<0.7` | F1 **0.922** vs 0.891; выигрыш именно на терсных многосоставных (221404). Замеренная доля эскалации ch2 ≈ 6 needs_human + UNKNOWN ≈ **6–10%**. Blended ≈ $12.8/1000 ≈ **$0.013/сообщение**. |
| Haiku как экстрактор | **нет** | F1 0.816, путает SL/TP‑сетап с входом (221404). Дёшево, но небезопасно. |

Opus — да, нужен, но только как **выборочная эскалация**, не как единственная ступень (single‑opus $15.5/1000 при +0.03 F1 — не окупается на всём трафике).

---

## 9. Изображения: кодирование, лимиты, ресайз, альбомы (проверено)

- **Кодирование:** base64, `media_type:"image/jpeg"` (весь дамп — .jpg). Блок `image` СТАВИТЬ ДО текста, метить `Image N:` для альбомов.
- **Лимиты Anthropic (docs, проверено WebFetch):** формат jpeg/png/gif/webp; **макс 8000×8000 px, 10 MB base64** (прямой API). До 100 картинок/запрос (для 200k‑моделей). Наш дамп: **макс 101.6 KB, макс 1280 px** — **ресайз не нужен**.
- **Стоимость визуальных токенов = ⌈w/28⌉×⌈h/28⌉** (не старая формула /750). Standard‑tier (**haiku‑4.5, sonnet‑4.5**): предел 1568 px/1568 vtok; high‑res (**opus‑4.8**): 2576 px/4784.
  - Landscape 1280×769 → **1288 vtok** (без даунскейла).
  - Portrait 961×1280 → 1610, 1128×1193 → 1763 → слегка даунскейлятся на standard‑tier. **Проверено: не мешает** — самая большая портретная карточка 221410 (101 KB) прочитана верно (`tp_hit SOL`+`modify_sl SOL`, вход 69.87). На Opus (2576 px) даунскейла нет вовсе.
- **Альбомы:** в дампе альбом = несколько ОТДЕЛЬНЫХ сообщений с общим `groupedId` (макс 4: 221378‑81). Если объединять в один запрос — 4×~1300 = ~5200 vtok, глубоко в лимитах. Практически на сообщение отправляется 1 картинка.
- **0 ошибок vision** на 127 сообщениях с картинками.

---

## 10. Кэш

- **Ключ кэширования разбора (application‑level):** `sha256(model + normalized_text + sorted(media_file_ids) + reply_parent_id + hash(open_positions_snapshot) + prompt_version)`. Открытые позиции входят в ключ, т.к. резолюция символа от них зависит (иначе тот же «Стоп на твх» разрешится по‑разному).
- **Anthropic prompt caching через прокси — РАБОТАЕТ** (в отличие от `system`‑поля): `cache_creation_input_tokens` на 1‑м вызове, `cache_read_input_tokens=4841` на всех последующих (проверено в прогонах). Кэшируется prefix = `tools`(схема ~2000 tok) + CC‑система(1370) + инструкция(~1470) = **4841 tok**.
  - Экономия на sonnet/opus: 4841×($3→$0.3)/M = **~$0.013/вызов**, окупает write (1.25×) со 2‑го сообщения (TTL 5 мин, трафик каналов плотнее).
  - **На Haiku НЕ кэшируется**: min prefix 4096 > нашего 3305 → `cache_read=0` (подтверждено эмпирически). Ещё одна причина не строить дешёвую ступень на Haiku.
  - Требование к стабильности prefix: схема инструмента и инструкция сериализуются детерминированно (фикс), в них НЕ вставлять дату/uuid — иначе кэш инвалидируется.

---

## 11. Надёжность / деградация

- **Отказ прокси / лимит подписки (429/5xx/529):** ретраи с экспоненциальным backoff (в харнессе 4 попытки, `2**att` c) — на 460 вызовах 0 финальных отказов. Коды: 429/500/502/503/529 — ретраить; 400/404/413 — не ретраить (лог, `needs_human`).
- **Может ли сообщение быть потеряно:** источник — MTProto‑userbot; каждое входящее ставить в **персистентную очередь (БД, статус `pending→parsed→executed`)** ДО вызова LLM. Парсинг — идемпотентный по `message_id`. При полном отказе AI‑слоя — сообщение остаётся `pending` и переразбирается; НИКОГДА не отбрасывается по таймауту. Порядок обработки в рамках канала — строго последовательный (reply/дельты зависят от предыдущего состояния).
- **Деградация:** при недоступности Opus — не эскалировать, помечать `needs_human=true` и не исполнять (лучше пропустить исполнение, чем исполнить неверно). При недоступности Sonnet — очередь копится, алерт; исполнение стопается (fail‑safe), т.к. торговая система не должна действовать вслепую.
- **Гейт исполнения:** любой action c `symbol==UNKNOWN` / `needs_human` / `confidence<порог` / расхождением с детерминированным парсером → **Skipped(reason)** в UI, без мутаций Bybit.

---

## 12. Согласование с детерминированным парсером (reconciliation)

Наблюдённая надёжность по полям диктует владельца:

| Поле | Владелец (authoritative) | Причина |
|---|---|---|
| Числовые entry/TP/SL/`Риск%` при совпавшем шаблоне | **Детерминированный парсер** | Точный regex‑захват цифр надёжнее LLM на числах (ch1‑блок; ch2‑карточка `#SYM Entry price/Targets/Stop Loss`) |
| symbol/side при совпавшем шаблоне | Детерминированный (сверка с AI) | `#SYM/USDT 📈LONG` однозначен |
| **symbol из КАРТИНКИ** (терсные «2🎯») | **AI** | regex бессилен, только vision |
| **symbol из reply‑цепочки / открытых позиций** | **AI** | требует контекста состояния |
| Маркеры: б/у→entry_price, «половину»→0.5, «один объём» | **AI** | символьная семантика |
| Тип/интент, мульти‑action декомпозиция, free‑form | **AI** | шаблон не матчится (весь ch2‑поток) |

**Правила при расхождении:**
1. Шаблон совпал ∧ AI согласен по (symbol, side, type) → числа берём из детерминированного, метод в UI = **«Auto parsing»**.
2. Шаблон НЕ совпал (терс/картинка/free‑form) → всё из AI, метод = **«AI parsing»**.
3. Шаблон совпал, но AI дал ДРУГОЙ symbol/side/type (или AI поднял `needs_human`) → **конфликт: не исполнять**, `Skipped(reason="parser_disagreement")`, ручная проверка. Число‑конфликт (одно поле) → берём детерминированное, флажок в UI.
4. `symbol==UNKNOWN` от AI, но шаблон дал символ → берём детерминированный символ (AI‑недобор контекста).

Поле **Method** в UI: `Auto parsing` для случая 1; `AI parsing` для 2 и для любого сообщения, где символ/маркеры пришли от vision или reasoning.

---

## 13. Итоговая экономика (на 1000 сообщений)

| Сценарий | $/1000 | Покрытие action’ов |
|---|---|---|
| Two‑stage Haiku‑classify → Sonnet (как в ТЗ) | 12.03 | **теряет 2–4.5%** ❌ |
| **Sonnet‑all (рекомендуется, база)** | **11.65** | понимание ~100%, F1 0.891 |
| Sonnet‑all + Opus‑эскалация (~8%) | ~12.8 | F1 → ~0.92 на сложных ✅ |
| Opus‑all | 15.52 | F1 0.922 |

Абсолютная стоимость мизерна (~$0.012–0.013/сообщение); при плотности каналов (~2‑3 сигнала/день на канал) — единицы центов в день. Оптимизировать нужно **не деньги, а покрытие** — а его убивает именно haiku‑гейт.

**Финальная рекомендация:** одна ступень **Sonnet‑4.5 на все не‑жёстко‑шумовые сообщения** с prompt‑caching и картинками, выборочная эскалация на **Opus‑4.8** по `needs_human || UNKNOWN || confidence<0.7`; Haiku исключить из критического пути. Все сообщения — через персистентную очередь, исполнение за детерминированным reconciliation‑гейтом.