# Фаза 4 — История, Win Rate, настройки, бэктест — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Оператор редактирует настройки канала (включает копитрейд, меняет размер/плечо), видит Win Rate по закрытым сделкам, отложенные лимитки с TTL-таймером, и может прогнать реплей-бэктест дампа. Решение о переходе на mainnet принимается по данным, а не вслепую.

**Architecture:** Достраиваются последние пробелы дизайна: вкладка Settings канала становится редактируемой (PATCH → `channel_settings`, оптимистичный апдейт), Win Rate считается из закрытых сделок с realized PnL, страница отложенных лимиток показывает `order.pending` с обратным отсчётом TTL. Реплей-бэктест — офлайн-инструмент: прогоняет накопленный дамп через пайплайн с историческими ценами Bybit (`kline`), считает, сколько входов отсеяли бы гварды и каков был бы PnL.

**Tech Stack:** тот же. Bybit `GET /v5/market/kline` для исторических цен в бэктесте.

**Спека:** `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md` (§12 пробелы дизайна: Win Rate, отложенные лимитки, Settings; §16 Ф4)
**Дизайн:** `design/project/Admin.dc.html` — вкладка Settings канала (строки 251-302), колонка Win Rate (161).

## Global Constraints

- Node `>=22`, pnpm 10, ESM, импорты `.js`, `strict` + `noUncheckedIndexedAccess`.
- Деньги/цены/qty — `NUMERIC`/`Decimal`/`string`, никогда `number`.
- Провайдеры NestJS — явный `@Inject(Class)`.
- Тесты — база `copytrade_test`. Не гонять несколько vitest параллельно (делят БД → флейк).
- Иконки только `lucide-react`. Дизайн 1:1 по `Admin.dc.html`. Секреты только в `.env`.
- `EXECUTION_MODE` управляет исполнением; настройки канала (`enabled`, trade_size, max_leverage,
  default_leverage, cross_margin) редактируются в UI и живут в `channel_settings`.
- Win Rate = `closed_wins / closed_trades` по realized PnL; до накопления истории показывает `—`.

## File Structure

```
apps/api/src/channels/
  channel-settings.controller.ts   # PATCH /api/channels/:id/settings
  stats.service.ts                 # Win Rate, closed trades, статистика канала
apps/api/src/history/
  history.controller.ts            # GET /api/history (закрытые сделки, realized PnL)
apps/api/src/orders/
  pending.controller.ts            # GET /api/orders/pending (отложенные лимитки + TTL)
apps/engine/src/backtest/
  replay.ts                        # реплей дампа через пайплайн + kline-цены
scripts/
  backtest.mjs                     # запуск бэктеста, отчёт
apps/web/src/routes/
  channel.tsx                      # Settings-таб: активные контролы + Save
  history.tsx                      # (опц.) закрытые сделки — если укладывается в дизайн
  positions.tsx                    # + секция/фильтр отложенных лимиток (pending)
```

---

### Task 1: Редактируемые настройки канала (Settings-таб)

**Files:** `apps/api/src/channels/channel-settings.controller.ts` + service, `apps/web/src/routes/channel.tsx` (Settings-таб активировать), тесты.

**Interfaces:**
- `PATCH /api/channels/:id/settings` body `{ enabled?, tradeSize?, maxLeverage?, defaultLeverage?, crossMargin? }`
  → обновлённый `ChannelSettingsDto`. Валидация: tradeSize>0, maxLeverage∈[1,instrMax], defaultLeverage опц.
- WS `channel.settings.updated` (для синхронизации других вкладок) — опционально.

- [ ] **Step 1: Тесты api** — `PATCH` меняет `enabled`/`tradeSize`/`maxLeverage` в `channel_settings`;
  валидация отклоняет tradeSize<=0, maxLeverage<1; без куки → 401.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** контроллер+сервис. Деньги — строки.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Фронт** — Settings-таб (`Admin.dc.html:251-302`): контролы АКТИВНЫ (toggle Copy trading,
  Trade size $, Max leverage x, Default leverage x, Allow cross margin toggle), кнопка Save →
  `PATCH`, флеш «Saved» (circle-check `#34d399`) на ~1.8с. react-hook-form + zod, оптимистичный апдейт,
  откат на ошибке (sonner).
- [ ] **Step 6: Тест web** — форма отправляет PATCH, показывает Saved; невалидный ввод — ошибка.
- [ ] **Step 7: Commit** — `feat: редактируемые настройки канала`

---

### Task 2: Win Rate и статистика закрытых сделок

**Files:** `apps/api/src/channels/stats.service.ts`, обновление `channels.service.ts` (winRate), тесты.

**Interfaces:**
- `channel.stats` (WS) и `ChannelDto.winRate` считаются из `trades` где `status='closed'`:
  `winRate = round(count(*) FILTER (is_win) / count(*) * 100) + '%'`; если закрытых нет → `'—'`.
- `is_win` выставляется при закрытии сделки (net realized_pnl > 0) — проверь, что engine/private-ws это пишет.

- [ ] **Step 1: Тесты** — засидить закрытые сделки (часть is_win=true) → `winRate` корректен;
  без закрытых → `'—'`. `channel.stats` обновляется при закрытии сделки.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** Убедись, что `trades.is_win` проставляется при закрытии (в private-ws
  `applyExecutionPush`/closeTrade или reconcile). Если нет — добавь: при переходе trade→closed
  `is_win = realized_pnl > 0`.
- [ ] **Step 4: Тесты зелёные** — колонка Win Rate в таблице каналов показывает реальный %.
- [ ] **Step 5: Commit** — `feat: Win Rate и статистика закрытых сделок`

---

### Task 3: Отложенные лимитки с TTL (pending orders)

**Files:** `apps/api/src/orders/pending.controller.ts` + service, `apps/web/src/routes/positions.tsx` (секция pending), тесты.

**Interfaces:**
- `GET /api/orders/pending` → `PendingOrderDto[]` (symbol, side, price, qty, channel, tradeRef,
  createdAt, ttlExpiresAt, покрытие — сколько осталось до TTL).
- WS `order.pending` / `order.resolved` (уже есть от Ф1/Ф3 — проверь) обновляют список.

- [ ] **Step 1: Тесты** — `GET /api/orders/pending` возвращает submitted entry/add-лимитки с TTL;
  filled/cancelled не попадают. TTL-остаток считается.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** контроллер + фронт-секцию. По дизайну — либо отдельная секция на Positions,
  либо отдельный экран (реши, что ближе к `Admin.dc.html`; в прототипе pending нет — минимальное решение
  из спеки §12: строка на Positions или под-таб). TTL-таймер (обратный отсчёт) в UI.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `feat: отложенные лимитки с TTL в UI`

---

### Task 4: Реплей-бэктест на дампе

**Files:** `apps/engine/src/backtest/replay.ts`, `scripts/backtest.mjs`, тест.

**Interfaces:**
- `replay({ channelKey, from, to }): Promise<BacktestReport>` — прогоняет накопленные `messages` канала
  через пайплайн в ИЗОЛИРОВАННОЙ БД/схеме (не трогая прод), с историческими ценами через
  `GET /v5/market/kline?category=linear&symbol=&interval=1&start=&end=` (цена на `t_msg`). Считает:
  сколько сигналов исполнилось бы, сколько отсеяли гварды (по причинам), симулированный PnL на факте.
- `BacktestReport`: `{ signals, executed, skipped: {reason: count}, simulatedPnl, entriesGuarded }`.

- [ ] **Step 1: Тесты** — реплей канала 2088626562 на фикстуре → отчёт с числами (executed/skipped/PnL);
  детерминирован (те же входы → тот же отчёт); не мутирует прод-БД.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать.** `kline_at(symbol, t_msg)` — цена на момент сообщения (research §6.2).
  Реплей использует те же чистые функции sizing/leverage/парсер. Гварды (staleness/adverse-drift)
  применяются как в проде. Изолированная схема/БД для реплея.
- [ ] **Step 4: `scripts/backtest.mjs`** — `pnpm backtest <channel>` печатает отчёт.
- [ ] **Step 5: Прогнать бэктест** канала 2088626562 → привести отчёт (сколько входов, PnL, что отсеяли гварды).
- [ ] **Step 6: Commit** — `feat: реплей-бэктест на историческом дампе`

---

### Task 5: Метрики и приёмка Ф4

**Files:** `apps/api/src/metrics/` (опц. ai_calls дашборд), обновление `LOOP_STATE.md`.

- [ ] **Step 1: (опц.) метрики** — эндпоинт со сводкой ai_calls (вызовы, стоимость, кэш-хиты, латентность
  p50/p95), выполненные/пропущенные действия. Если укладывается — маленькая панель; иначе SQL-отчёт.
- [ ] **Step 2: Приёмка Ф4.** Собрать стек. Проверить в UI:
  - Settings канала: включить копитрейд, изменить trade_size → Save → «Saved», значение сохранилось (перезагрузка).
  - Win Rate: колонка каналов показывает % (по закрытым сделкам, если есть; иначе `—` с объяснением).
  - Positions: отложенные лимитки с TTL видны (если есть submitted-лимитки).
  - Бэктест: `pnpm backtest ch-2088626562` даёт осмысленный отчёт.
  Привести SQL и скриншоты.
- [ ] **Step 3: Обновить `LOOP_STATE.md`** — Ф4 выполнена, все 5 фаз завершены, грабли.
- [ ] **Step 4: Commit** — `feat: фаза 4 — история, Win Rate, настройки, бэктест`

---

## Definition of Done для Ф4

- Оператор редактирует настройки канала (Copy trading toggle, trade size, leverage, cross margin) и сохраняет.
- Win Rate каналов считается из закрытых сделок с realized PnL.
- Отложенные лимитки видны с TTL-обратным отсчётом.
- Реплей-бэктест прогоняет дамп и даёт отчёт (executed/skipped/PnL/что отсеяли гварды).
- `pnpm test` и `pnpm typecheck` зелёные.
- Решение о переходе на mainnet может приниматься по данным бэктеста, а не вслепую.

## Что осознанно не делается в Ф4

Реальный переход на mainnet (отдельное решение оператора после бэктеста). Провижининг субаккаунтов на
mainnet (скрипт есть). Расширение на новые каналы (архитектура готова — новый адаптер). Форум в live.
