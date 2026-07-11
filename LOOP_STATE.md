# LOOP_STATE

## Goal

Фаза 2, задача 7 (финальная задача Ф2): включить форум `1962583820` в обработку engine наравне
с каналом `2088626562`, закрыть находку задачи 6 (`needs_review` не писал action-строку —
оператор не видел непонятые сообщения), провести приёмку Ф2.

Источник: `.superpowers/sdd/task-7-brief.md`.

Файлы: `apps/engine/src/main.ts`, `apps/engine/src/pipeline.ts`,
`apps/engine/test/pipeline-ai.e2e.test.ts`, `apps/web/src/lib/action-display.tsx`,
`apps/web/test/timeline.test.tsx`, `apps/web/test/actions.test.tsx`, `LOOP_STATE.md`.

## Status

- [x] Прочитаны task-7-brief.md, pipeline.ts/reconciler.ts/main.ts, p2-task6-report.md
      (находка задачи 6), progress-phase2.md.
- [x] **Находка задачи 6 закрыта**: `pipeline.ts` при исходе `needs_review` теперь вставляет
      синтетическую actions-строку (`ensureWholeMessageSkipped` обобщена в
      `ensureWholeMessageAction(trx, message, reason, method, status)`, status ∈
      {'skipped','needs_review'}) — `type='open'` (та же условность, что и у skip-ветки, symbol
      реально не восстановить), `symbol=null`, `skip_reason=decision.reason`,
      `method='review'`. Фронт (задача 6, `isNeedsReviewReason`) уже рисовал бейдж "Needs
      review" по `skipReason` — строки не хватало.
- [x] **Вторая находка (обнаружена приёмкой, не была известна заранее)**: `NEEDS_REVIEW_REASONS`
      во фронте (`action-display.tsx`, задача 6) перечисляла только 4 причины
      (`parser_disagreement`/`ai_unavailable`/`needs_human`/`low_confidence`) — реальные
      needs_review-сообщения форума в основном несут `symbol_unknown_needs_vision` (AI не
      определил символ, `normalize-output.ts: resolveReason()`) и теоретически
      `ai_unresolved_marker` — ни один не входил в список, бейдж падал на "Skipped". Это была
      явно предсказана в `p2-task6-report.md` (Сомнения п.2: "если такое всплывёт в задаче 7").
      Всплыло: 2 из 75 сообщений приёмки. Добавлены оба значения + 2 регресс-теста
      (`timeline.test.tsx`, `actions.test.tsx`).
- [x] **Третья находка (обнаружена приёмкой)**: `extract_signal.summary` (обязательное поле
      AI tool-схемы, `schema.ts`) нигде не читался пайплайном — `messages.ai_summary` оставался
      NULL даже для `method='ai'`, sparkles-саммари никогда не рендерился на реальных данных.
      `runAiBranch` теперь возвращает `{parsed, summary}`, `processMessage` пишет
      `ai_summary` во ВСЕХ 4 ветках (noise/needs_review/skipped/executing). Тест на
      `messages.ai_summary` добавлен в `pipeline-ai.e2e.test.ts`.
- [x] `apps/engine/src/main.ts`: `DETERMINISTIC_ADAPTER_ID` (только CH1) заменён на
      `KNOWN_ADAPTER_IDS = ['ch1-structured','ch2-freeform']` — engine забирает `active`-каналы
      обоих адаптеров. Порядок обработки внутри каждого канала строго последовательный
      (`withChannelLock` не менялся) — деградация AI на форуме не блокирует CH1 в том же тике.
- [x] `pnpm --filter engine test` → 254 passed (22 файла, было 254 — 3 теста needs_review
      обновлены под новое поведение + 1 новый на ai_summary). `pnpm --filter web test` → 45
      passed (было 43, +2 регресс-теста needs-review-reasons). `pnpm -r typecheck` → 7/7 чисто.
- [x] Приёмка: выборка 75 последних сообщений форума (tg_message_id 221384..221460, окно
      заведомо содержит терсные с картинками — `2🎯`, `Фикс половину`, `Стоп на твх`,
      `1🎯стоп на твх`) обработана ЧЕРЕЗ `processMessage()` (тот же код, что и main.ts) —
      52 executed, 4 needs_review (2 `ai_unavailable`+`symbol_unknown_needs_vision` из
      контролируемого теста деградации, 2 из основной выборки), 21 noise. `ai_calls`: 34,
      cost $0.47179. Playwright: символ из картинки виден (BTCUSDT "2🎯" → 28.95%/17.28% из
      WEEX-карточки), Method "AI parsing", sparkles-саммари, "Needs review" бейдж на symbol
      unknown кейсе. Скриншоты `/tmp/p2-forum*.png`, `/tmp/p2-actions.png`.
- [x] Деградация вживую: `docker compose stop ai-proxy`, 2 форум-сообщения (нетронутый
      бэклог, tg=221372/221354, прямой вызов `processMessage()`, НЕ через живой поллер —
      см. "Грабли" ниже) → `needs_review`/`ai_unavailable`, actions-строка создана, 0 orders;
      CH1-сообщение (tg=923, `#MOODENG/USDT LONG`) в ТОМ ЖЕ прогоне → `executed`, `trade_id`
      прежний (идемпотентно). `docker compose start ai-proxy` — healthy.
- [x] Отчёт `.superpowers/sdd/p2-task7-report.md`.
- [ ] Коммит (`apps engine`/`apps web`/`LOOP_STATE.md`, БЕЗ `AGENTS.md`).

## LOOP ЗАВЕРШЁН (кроме коммита выше)

## Грабли Ф2 (все задачи, накопительно)

- **ai-proxy молча игнорирует поле `system`** — инструкции класть в user-turn с `cache_control`.
  Prompt caching работает (`cache_read` в ответах). Прокси добавляет ~1.3-1.4k input-токенов
  системного промпта Claude Code в КАЖДЫЙ запрос — учитывать в стоимости.
- **Символ терсных сообщений форума резолвится ТОЛЬКО из картинки** — текст типа `2🎯`/`Фикс
  половину` без vision бессмыслен, WEEX-скриншот с parою/направлением/плечом — единственный
  источник символа.
- **`needs_review` должен писать action-строку** (эта задача) — иначе оператор не видит в UI
  ни одного из непонятых/спорных сообщений, только накопление в БД без интерфейса.
- **Список needs_review-причин на фронте должен быть синхронизирован с ДВУМЯ источниками**:
  `reconciler.ts` (`parser_disagreement`/`low_confidence`/`ai_unavailable`) И
  `ai/normalize-output.ts: resolveReason()` (`symbol_unknown_needs_vision`/`needs_human`/
  `ai_unresolved_marker`) — пропуск любого из шести на фронте молча превращает "Needs review"
  в "Skipped".
- **`PROMPT_VERSION` инвалидирует `ai_cache`** при смене промпта (v1→v2, задача 5) — ожидаемо,
  но нужно помнить при калибровке: старый кэш не переиспользуется под новый промпт.
- **Деградация fail-safe подтверждена вживую**: отказ ai-proxy НЕ роняет транзакцию/сообщение
  (`runAiBranch` ловит исключение, возвращает null, reconciler доводит до `needs_review`), CH1
  в ТОМ ЖЕ тике/прогоне продолжает работать — детерминированный путь не вызывает AI вообще.
- **Живой поллер `main.ts` НЕЛЬЗЯ просто "включить" на канал с большим необработанным
  бэклогом** — `processChannel()` берёт 50 САМЫХ СТАРЫХ `received` по `tg_message_id ASC`;
  форум имел 1657 `received` (1657-N с начала истории), и первый же рестарт `engine`-контейнера
  с новым `main.ts` НАЧАЛ их обрабатывать (случайно затронул 43 старых сообщения до того, как
  это было замечено и остановлено/откачено). Приёмка выборки последних ~75 и деградация
  сделаны ПРЯМЫМ вызовом `processMessage()` (тот же код, что и engine) на конкретных
  `tg_message_id`, а не через живой поллер — иначе поллер прошёл бы весь старый бэклог раньше,
  чем добрался бы до специально выбранных/сброшенных сообщений. Контейнер `engine` в docker
  сейчас **остановлен** (`docker compose stop engine`) — код смёржен и корректен, но старт
  живого поллера начнёт дорабатывать оставшиеся ~1580 старых сообщений форума (оценка ~$10
  AI-бюджета на всю историю, безопасно — dry-run, copy trading выключен для форума по
  умолчанию) — решение "включать сейчас или нет" оставлено оператору осознанно, не принято
  за него.
- **`extract_signal.summary` — обязательное поле схемы, но пайплайн его не читал** (найдено
  этой приёмкой) — `messages.ai_summary` был NULL даже для `method='ai'`, sparkles-блок
  дизайна никогда не появлялся на реальных данных. Почищено.
- **Copy trading выключен по умолчанию** (`channel_settings.enabled=false`) — ВСЕ actions
  форума в приёмке получили `status='skipped', skip_reason='copy_disabled'` (кроме
  needs_review) — символ/тип определяются и видны корректно, но ордера не идут ни для одного
  канала, пока оператор явно не включит Copy trading (design intent, не баг).

## Известные грабли Ф0/Ф1 (не менялись, для справки)

- Порт `8317` у ai-proxy нельзя переназначать (OAuth-редирект на `127.0.0.1:<port>`).
- `pnpm up` — зарезервированный алиас pnpm; корневой скрипт — `pnpm run up`.
- Порт хоста postgres — `POSTGRES_PORT=5442`.
- Пересборка контейнеров: `docker compose up -d --build`.
