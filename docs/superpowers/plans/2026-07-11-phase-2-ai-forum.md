# Фаза 2 — AI-слой и форум 1962583820 — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Терсные сообщения форума (`2🎯`, `Фикс половину`, `Стоп на твх`) превращаются в действия с правильным символом — символ берётся из картинки, reply-цепочки или открытых позиций. Отказ ai-proxy не теряет сообщения: CH1 продолжает работать на парсере, CH2 уходит в `needs_review`.

**Architecture:** Engine получает AI-слой: клиент ai-proxy (Anthropic-совместимый, forced `tool_choice`, vision, prompt caching), нормализатор AI-вывода в те же `ParsedIntent`, кэш разбора. Reconciler сливает детерминированный и AI-путь по таблице владения полями. Адаптер CH2 обрабатывает форум: структурные сигналы — детерминированно, свободный текст и терсные дельты — через AI с картинкой и контекстом открытых позиций.

**Tech Stack:** тот же. AI через `http://ai-proxy:8317/v1/messages` (в контейнере) / `http://127.0.0.1:8317` (локально), без ключа.

**Спека:** `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md` (§7 AI-слой, §6 reconciler)
**Исследования:** `docs/superpowers/research/ai-layer.md` (§3 схема, §4 промпт, §9 картинки, §10 кэш, §11 деградация, §12 reconciliation), `docs/superpowers/research/channel-adapters.md` §2 (CH2 детерминированная часть), §6 (матчинг дельт), §7 (ошибки атрибуции), §9 (алиасы)

## Global Constraints

- Node `>=22`, pnpm 10, ESM, импорты `.js`, `strict` + `noUncheckedIndexedAccess`.
- Деньги/цены/qty — `NUMERIC`/`Decimal`/`string`, никогда `number` в денежной арифметике.
- Провайдеры NestJS — явный `@Inject(Class)`.
- Тесты — база `copytrade_test` через `packages/test-db`.
- **ai-proxy молча игнорирует поле `system`** — вся инструкция в ПЕРВОМ `text`-блоке user-turn с `cache_control: {type:"ephemeral"}`. Заголовки: `content-type: application/json`, `anthropic-version: 2023-06-01`. Ключ не нужен.
- **LLM не считает арифметику** — вычисляемые величины (безубыток, «один объём», «с текущих») отдаёт символьными маркерами; число подставляет код из состояния.
- **Картинка ставится ДО текста** в user-turn, метится `Image N:`.
- Модель: **Sonnet 4.5** (`claude-sonnet-4-5-20250929`) основная; эскалация на **Opus 4.8** (`claude-opus-4-8`) при `needs_human || symbol==UNKNOWN || confidence<0.7`. Haiku НЕ используется как drop-гейт (теряет действия).
- Prompt caching работает через прокси на user-блоках — схема+инструкция сериализуются ДЕТЕРМИНИРОВАННО (без даты/uuid в кэшируемом префиксе), иначе кэш инвалидируется.
- Деградация fail-safe: отказ AI → сообщение остаётся обрабатываемым (не теряется), CH2 → `needs_review`, никаких мутаций при `UNKNOWN`/`needs_human`/конфликте.
- Секреты только в `.env`. Комментарии по-русски. Иконки только `lucide-react`.

---

## File Structure

```
apps/engine/src/ai/
  client.ts            # POST /v1/messages, forced tool_choice, vision, cache_control, ретраи, эскалация
  schema.ts            # extract_signal input_schema (research §3, дословно)
  prompt.ts            # системная инструкция (research §4.1) + сборка user-turn (§4.2)
  normalize-output.ts  # AI extract_signal → ParsedIntent[] (те же типы domain.ts)
  cache.ts             # ключ разбора (§10), чтение/запись ai_cache
  context.ts           # компактный снимок открытых позиций канала (§4.4), reply-parent, картинки
apps/engine/src/adapters/
  ch2.adapter.ts       # детерминированная часть CH2 (research §2) + маршрут в AI
apps/engine/src/reconciler.ts   # РАСШИРИТЬ: слияние det+ai по таблице владения (§12)
apps/engine/src/pipeline.ts     # РАСШИРИТЬ: AI-ветка, деградация, needs_review
apps/api/src/ai/ai-calls.controller.ts  # (опц.) метрики стоимости для будущего
apps/web/src/components/MessageTimeline.tsx  # РАСШИРИТЬ: AI-саммари (sparkles), Method, needs_review
```

---

### Task 1: AI-клиент ai-proxy (forced tool_use, vision, кэш, ретраи, эскалация)

**Files:** `apps/engine/src/ai/{client,schema,prompt}.ts`, тест `apps/engine/test/ai-client.test.ts`

**Interfaces:**
- `callExtractSignal({ text, tMsg, replyParentText?, openPositions, images: {base64,mediaType}[], model }): Promise<{ output: ExtractSignalOutput, usage, model, latencyMs, cacheHit }>`.
- `ExtractSignalOutput` — тип по схеме research §3.

- [ ] **Step 1: Тест на живом ai-proxy** — реальное сообщение `2🎯` с картинкой (`temp/tg-dump/ch-1962583820-t173666/media/221437.jpg` — SOLUSDT карточка) → `extract_signal` возвращает `actions` с `symbol` из картинки (`SOLUSDT`), `image_used: true`, `evidence_source` в `image`/`both`. Forced tool_choice → всегда tool_use. Таймаут 60 с. Если прокси недоступен — явный skip.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать.** Схема `extract_signal` (§3 дословно). Промпт: первый user-блок = инструкция §4.1 + схема, с `cache_control`; затем `Image N:` + картинка; затем контекст (t_msg, reply, OPEN_POSITIONS, текст) §4.2. `tool_choice: {type:'tool', name:'extract_signal'}`. Ретраи (429/500/502/503/529 → backoff, 400/404/413 → не ретраить). Запись в `ai_calls` (model, tokens, cost, latency, cache_hit, escalated).
- [ ] **Step 4: Тест зелёный** — привести фактический вывод (symbol, image_used, usage).
- [ ] **Step 5: Commit** — `feat(engine): AI-клиент ai-proxy с forced tool_use и vision`

---

### Task 2: Нормализация AI-вывода в ParsedIntent + кэш разбора

**Files:** `apps/engine/src/ai/{normalize-output,cache,context}.ts`, миграция под `ai_cache`/`ai_calls` если колонок не хватает, тесты.

**Interfaces:**
- `normalizeAiOutput(output: ExtractSignalOutput, ctx): ParsedResult` — маппит `extract_signal.actions[]` в `ParsedIntent[]` (те же типы), маркеры (`entry_price`, `one_unit`, `current_price`) сохраняет как символьные (не числа), `route`: `execute` если всё резолвится, `ai`/`needs_review` если `UNKNOWN`/`needs_human`.
- `cacheKey({ model, normalizedText, mediaIds, replyParentId, openPositionsHash, promptVersion }): string` (§10).
- `buildContext(db, message): { openPositions, replyParentText, images }` — компактный снимок открытых позиций канала (§4.4), текст reply-родителя, картинки из `message_media` (base64).

- [ ] **Step 1: Тесты** — `normalizeAiOutput` переводит `modify_sl marker=entry_price` в `DeltaOp sl_breakeven` (без числа); `close_amount fraction 0.5` → `partial_close fraction 0.5`; `close_amount units marker=one_unit` → `partial_close` с маркером «один объём»; `symbol=UNKNOWN` → route `needs_review`. Кэш: одинаковый вход → тот же ключ; разный снимок позиций → разный ключ.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** `ai_cache(request_hash PK, model, prompt_version, response JSONB, created_at)` — уже в схеме (миграция 001), проверь. Открытые позиции в ключ входят (символ зависит от них).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): нормализация AI-вывода, кэш разбора, контекст позиций`

---

### Task 3: Адаптер CH2 (детерминированная часть + маршрут в AI)

**Files:** `apps/engine/src/adapters/ch2.adapter.ts`, регистрация в `registry.ts`, тест на фикстуре форума.

**Interfaces:** `ChannelAdapter.parse(ctx): ParsedResult` — как у CH1.

CH2 по research §2 (порядок, первый матч):
- **A. STRUCTURED SIGNAL** (conf 1.0): `#TICKERUSDT` + `Entry price` + `Targets`. keycap-сплит целей.
- **B. LIMIT_ENTRY** (0.8): `limit` + `long/short`, сплит по `\n` и ` + ` → сегменты, несколько ордеров.
- **C. MARKET_ENTRY** (0.7): `с текущих/relong/перезах/повторный лонг` + направление.
- **D. DELTA_SL с тикером** (0.75 → DET): `sl/стоп` + тикер в тексте.
- **E/F. Всё остальное** (символ-less дельты, свободный текст, картинки) → route `ai`.

- [ ] **Step 1: Тест-фикстура.** Скопировать `temp/tg-dump/ch-1962583820-t173666/messages.jsonl` в `apps/engine/test/fixtures/ch2.jsonl` (закоммитить). Прогнать 100 сообщений: DET≈35, AI≈31, NOISE≈34 (research §0, ±3, задокументировать). Точечные: `221443` structured SOLUSDT; `221428` `Limit long btc 60850 + limit long btc 60000` → 2 ордера BTC; `2🎯` → route `ai`; аналитика → noise.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать** A–D детерминированно, E/F → AI. Учесть баг слитного `#SOLUSDT` (резолвер даёт `SOLUSDTUSDT` — вырезать чистый тикер до резолва).
- [ ] **Step 4: Тест зелёный** — покрытие ≈ research §0.
- [ ] **Step 5: Commit** — `feat(engine): адаптер CH2 — структурные сигналы + маршрут в AI`

---

### Task 4: Reconciler det+ai + AI-ветка пайплайна + деградация

**Files:** `apps/engine/src/reconciler.ts` (расширить), `apps/engine/src/pipeline.ts` (расширить), тесты.

Reconciler по таблице владения research §12:
- шаблон совпал ∧ AI согласен (symbol,side,type) → числа из детерминированного, Method `auto`;
- шаблон не совпал → всё из AI, Method `ai`;
- шаблон совпал, но AI дал другой symbol/side/type или `needs_human` → конфликт, `Skipped(parser_disagreement)`;
- `symbol==UNKNOWN` от AI, но шаблон дал символ → берём детерминированный.

Пайплайн: для route `ai` — собрать контекст (позиции+reply+картинки), проверить кэш, вызвать AI (Sonnet, эскалация Opus), нормализовать, реконсилировать. Гейт исполнения: `UNKNOWN`/`needs_human`/`confidence<порог`/конфликт → `needs_review`, без исполнения. **Деградация:** ai-proxy недоступен → CH1 работает как раньше (детерминированный путь не зовёт AI), CH2 route `ai` → `needs_review` + алерт, сообщение НЕ теряется (остаётся переобрабатываемым).

- [ ] **Step 1: Тесты** — reconcile-конфликт → `parser_disagreement`; AI `UNKNOWN` при шаблонном символе → берём шаблон; деградация (замокать недоступный AI) → CH2 сообщение `needs_review`, 0 ордеров, CH1 продолжает исполнять. Символ-less дельта с одной открытой позицией → матчится.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** reconciler и AI-ветку. Кэш перед вызовом AI. Строгий порядок обработки форума (дельты зависят от предыдущего состояния).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(engine): reconciler det+ai, AI-ветка пайплайна, деградация fail-safe`

---

### Task 5: Golden set и прогон форума через AI

**Files:** `apps/engine/test/fixtures/ch2-golden.json` (ручная разметка 30 сложнейших сообщений форума), тест `apps/engine/test/ai-golden.test.ts`.

- [ ] **Step 1: Разметить golden set** — 30 самых сложных сообщений форума (терсные `2🎯`, `Фикс половину`, `Стоп на твх`, мульти-символ, картинки) с ожидаемым `(symbol, type, side)`. Основа — research §7 (E1-E6 ошибки) и §0. Разметка — глазами, читая сообщения и картинки.
- [ ] **Step 2: Тест** — прогнать golden set через реальный AI-слой (Sonnet, эскалация Opus), сравнить с разметкой. Метрика: precision/recall по `(symbol, type)`. Порог: recall ≥ 0.85 (не терять действия — главное). Тест ходит в живой ai-proxy, таймаут щедрый (30 сообщений × ~5 c), кэш ускоряет повторы. Skip если прокси недоступен.
- [ ] **Step 3: Реализовать/откалибровать** промпт до достижения порога. Привести фактические precision/recall и примеры расхождений.
- [ ] **Step 4: Commit** — `test(engine): golden set форума, метрика извлечения действий`

---

### Task 6: Фронт — AI-саммари, Method, needs_review в таймлайне и Actions

**Files:** `apps/web/src/components/MessageTimeline.tsx` (расширить), `apps/web/src/routes/actions.tsx` (Method AI parsing), тесты.

- [ ] **Step 1: Тесты** — сообщение с `aiSummary` и `method='ai'` рендерит блок саммари с иконкой `sparkles` (`#ff8a4d`); action с `needs_review` рендерит соответствующий бейдж; на странице Actions Method показывает `AI parsing` (`#ff8a4d` 600) для AI-разобранных.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** по дизайну (таймлайн 234-243: саммари sparkles; Method-колонка 655-656). `needs_review` — бейдж (тултип с причиной).
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat(web): AI-саммари, Method и needs_review в UI`

---

### Task 7: Engine обрабатывает форум, приёмка Ф2

**Files:** engine main (расширить — включить канал форума в обработку), обновление `LOOP_STATE.md`.

- [ ] **Step 1: Включить форум** `1962583820` (adapter `ch2-freeform`) в engine-loop наравне с каналом.
- [ ] **Step 2: Собрать стек** `pnpm run up`. Engine обрабатывает оба источника. Форум идёт через AI.
      ВНИМАНИЕ по стоимости: не гнать весь форум разом бесконтрольно — обработка идёт по мере поступления,
      кэш снижает повторы. Для приёмки достаточно, что терсные сообщения резолвятся.
- [ ] **Step 3: Приёмка вручную.** Открыть UI: канал форума в таймлайне — под терсными сообщениями
      (`2🎯`, `Фикс половину`) видны распознанные действия с правильным символом (из картинки), Method `AI parsing`,
      AI-саммари. Часть → needs_review (символ не определён / низкая уверенность). Привести SQL:
      `select method, count(*) from actions a join messages m on m.id=a.message_id where m.channel_id=1962583820 group by 1`;
      `select count(*) from ai_calls`.
- [ ] **Step 4: Деградация вживую.** Остановить ai-proxy (`docker compose stop ai-proxy`), дать engine
      обработать новое форум-сообщение → оно `needs_review`, 0 ордеров, CH1 продолжает работать.
      Вернуть ai-proxy. Привести вывод.
- [ ] **Step 5: Обновить `LOOP_STATE.md`** — Ф2 выполнена, грабли.
- [ ] **Step 6: Commit** — `feat: фаза 2 — AI-слой и форум 1962583820`

---

## Definition of Done для Ф2

- Терсные сообщения форума (`2🎯`, `Фикс половину`, `Стоп на твх`) → действия с правильным символом из картинки/reply/позиций.
- Структурные сигналы форума — детерминированно; свободный текст и терсные дельты — через AI.
- Reconciler разрешает конфликт det/ai; `UNKNOWN`/`needs_human`/низкая уверенность → `needs_review` без исполнения.
- Отказ ai-proxy не теряет сообщения: CH1 работает на парсере, CH2 → `needs_review`.
- Golden set: recall извлечения действий ≥ 0.85.
- UI показывает AI-саммари (sparkles), Method `AI parsing`, needs_review.
- `pnpm test` и `pnpm typecheck` зелёные.

## Что осознанно не делается в Ф2

Реальные ордера на бирже (Ф3 — по-прежнему dry-run). Провижининг субаккаунтов (Ф3). История закрытых сделок с realized PnL (Ф4). Двухступенчатый Haiku-классификатор (отвергнут эмпирикой — теряет действия).
