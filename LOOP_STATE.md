# LOOP_STATE

## Goal (новый loop — мониторинг сделок/PnL/баланса)

1. Пагинация для Actions и Positions.
2. Вкладки open/closed позиций (смотреть закрытые тоже).
3. Фикс рассинхрона: сейчас показывает кучу open-позиций, которых нет на Bybit (engine в докере, dry_run).
4. Статистика Positions: глобальный и по-канальный текущий PnL + баланс каждого субаккаунта (канала).

Итог: полноценный мониторинг сделок и статуса по PnL/балансу, статистика общая и по каждому каналу.

## Разведанные факты
- `.env`: EXECUTION_MODE=dry_run, BYBIT_NETWORK=demo. Engine запущен в Docker.
- 76 open trades/positions (канал 2088626562), все dry-run (симуляция) → «фантомные» opens.
- Нет таблиц wallet/equity/balance/subaccount.
- Активен только 2088626562; форум 1962583820 сделок не имеет.

## Решения (утверждены пользователем)
- Движок → LIVE на demo (реальный PnL/баланс, рассинхрон уходит сам). Перед стартом — чистка 76 фантомов.
- Баланс: один demo-аккаунт + виртуальная разбивка PnL по каналам (DTO под будущие субаккаунты).
- Пагинация keyset-cursor; Closed = закрытые trades (отдельный DTO/эндпоинт); wallet_snapshots писатель в engine.

План: `docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md`.

## Status
- [x] understand-workflow (5 читателей + синтез, код-verified).
- [x] Дизайн-решения + план (коммит 8195269).
- [x] Task 1 — DTO мониторинга + миграция wallet_snapshots (коммит `0fc3551`).
- [x] Task 2 — backend API: пагинация positions, /positions/history, stats+by-channel, /account/wallet (`175b1d5`).
      Адаптации: positions PK составной → курсор id="chan:sym"; exitPrice через executions⨝orders(reduce_only);
      history-курсор по human_ref. api 115+1skip.
- [x] Task 3 — engine: писатель wallet_snapshots (live, 30с) + скрипт чистки (коммит `cc04ac1`). engine 387+18skip.
- [x] Task 4 — frontend: пагинация (useCursorList/LoadMore), вкладки Open/Closed, панели PnL/баланс (`85c95f3`). web 78.
- [x] Task 5 — live-переключение + чистка фантомов:
      - Чистка: 76 сделок→closed, 76 позиций→0, 76 символов освобождено, 219+117 ордеров→cancelled. Идемпотентно.
      - `.env` EXECUTION_MODE=live (demo). Engine пересобран+перезапущен.
      - Live проверено: reconcileOnStart opened=0 closed=0 flagged=0 (БД=пустой Bybit), equity 165911.78 USDT
        реальный, private-ws auth+subscribe success. wallet_snapshots копится каждые 30с.
      - /account/wallet: $165,911.78 equity / $99,958.99 available + per-channel. /positions/stats: 0 open, чисто.
- [x] Интеграционный typecheck 4/4 + полный набор тестов: shared 25 · api 115+1skip · engine 387+18skip ·
      web 78 · tg-ingest 40 = 645 прошли.
- [x] Адверсариал-ревью (workflow review-monitoring, 4 измерения + verify): 9 подтверждённых находок.
      Фиксы (коммит `0414b56`):
      - F1 CRITICAL: getPositions/getOpenOrders читали только 1-ю страницу Bybit (≤20) → reconcile
        осиротил бы позиции 21+. Добавлен signedGetAllPages (cursor-цикл + limit + потолок 50).
      - F2 CRITICAL + F8 IMPORTANT: reconcile закрывал/отменял свежие сделки по устаревшему pre-tx
        снапшоту. Recency-гейт по opened_at (та же CREATED_TIME_TOLERANCE_MS, что шаг А).
      - F4 IMPORTANT: пустой equity Bybit ('') ломал INSERT снапшота → pickNonEmptyEquity fallback.
      - F5 IMPORTANT: чистка без guard на live → checkCleanupLiveGuard (--force-live).
      - F6 IMPORTANT: пагинация позиций по volatile updated_at → стабильный trades.opened_at.
      - F7 IMPORTANT: size=0 прятал 'Load more' → рефетч границы. F9 MINOR: патч под фильтром → рефетч.
- [x] Engine пересобран с фиксами, live-старт чистый (reconcile 0/0/0, equity 165911.78, snapshots идут).
- [x] Финальные тесты: engine 403+18skip, api 116+1skip, web 80, shared 25, tg-ingest 40. Typecheck 5/5.

## Known limitations (осознанно НЕ исправлено сейчас)
- **F3 (ревью, CRITICAL при 2 включённых каналах):** один общий Bybit-аккаунт на все каналы
  (getChannelKeys(db,null), one-way positionIdx=0). Если ДВА канала включены и открывают ОДИН символ,
  Bybit неттит их в одну позицию с произвольной атрибуцией. СЕЙЧАС НЕ ДОСТИЖИМО: оба канала disabled,
  форум 1962583820 сделок не имеет, активная торговля только при явном включении одного канала.
  Правильное решение — per-channel субаккаунты (design end-state; на demo-хосте create-sub недоступен)
  ЛИБО глобальная эксклюзивность символа. Не менял core acquireSymbol ради недостижимого сценария.
  ВКЛЮЧАТЬ ОДНОВРЕМЕННО ОБА КАНАЛА НА ПЕРЕСЕКАЮЩИХСЯ СИМВОЛАХ — НЕЛЬЗЯ до внедрения субаккаунтов.

## Итог loop
Все 4 требования цели закрыты: (1) пагинация Actions/Positions, (2) вкладки Open/Closed, (3) рассинхрон
устранён (движок live на demo, 76 фантомов вычищены, позиции = зеркало биржи, reconcile 0/0/0),
(4) статистика PnL глобально/по-каналам + реальный баланс аккаунта ($165,911.78 с demo). Плюс исправлены
латентные live-desync баги исполнения, всплывшие при переходе в live. Каналы disabled (авто-торговли нет —
оператор включает через Settings, когда готов). Коммиты: 8195269, 0fc3551, 175b1d5, cc04ac1, 85c95f3, 0414b56.
