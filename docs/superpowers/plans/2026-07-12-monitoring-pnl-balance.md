# Мониторинг: пагинация, open/closed, live-reconcile, PnL/баланс — план

**Goal:** Полноценный мониторинг сделок и статуса по PnL/балансу. Оператор видит: пагинированные
Actions/Positions, вкладки Open/Closed, глобальный и по-канальный текущий PnL, баланс аккаунта.
Рассинхрон устранён: движок в **live на Bybit demo**, позиции зеркалят биржу.

**Решения (утверждены пользователем):**
- Движок → **live на demo** (`EXECUTION_MODE=live`, `BYBIT_NETWORK=demo`). Перед первым live-стартом —
  разовая чистка 76 фантомных dry_run позиций.
- Баланс: один demo-аккаунт + виртуальная разбивка PnL по каналам. Реальные субаккаунты на demo
  недоступны — DTO заложить под будущее, но не провижинить.
- Пагинация: keyset-cursor (bare-array конвенция как в `actions.service.ts`), переиспользовать паттерн
  `MessageTimeline`/`listActions`.
- Closed = закрытые `trades` (не `positions`): отдельный `ClosedTradeDto`, `GET /positions/history`.
  Причина закрытия (tp/sl/manual/liquidation) из `actions`; `cancelled` — отдельный бейдж.
- Доставка баланса: движок пишет `wallet_snapshots` по TTL, API читает (не дублируем Bybit-клиент в api).

**Источник анализа:** understand-workflow synthesis (в контексте). Ключевые файлы:
`positions.service.ts:147,176`, `main.ts:251-271`, `reconcile.ts:100-190`, `actions.service.ts` (готовый
курсор), `channels.service.ts::listMessages` + `MessageTimeline.tsx` (эталон infinite-query).

## Global Constraints
- Node ≥22, ESM, импорты `.js`, `strict`+`noUncheckedIndexedAccess`. Провайдеры — явный `@Inject`.
- Деньги/цены/qty/PnL — строки/Decimal, НИКОГДА number. NUMERIC в БД.
- Иконки только lucide-react; тёмная тема; дизайн 1:1 (`design/project/Admin.dc.html`).
- Тесты — `copytrade_test`, НЕ параллельно (общая БД). Секреты только в `.env`.
- Не трогать TG_SESSION, не слать Telegram, `AGENTS.md` не коммитить.

---

### Task 1 — Shared DTO + миграция wallet_snapshots (фундамент)
**Files:** `packages/shared/src/dto.ts`, новая миграция `apps/api/src/db/migrations/006_wallet_snapshots.ts`,
`apps/api/src/db/database.ts` (Kysely-типы).
- `wallet_snapshots`: `id uuid pk`, `channel_id bigint null` (null=account-level, задел под субаккаунты),
  `total_equity numeric(30,10)`, `available_balance numeric(30,10)`, `currency text default 'USDT'`,
  `created_at timestamptz default now()`. Индекс `(channel_id, created_at DESC)`.
- DTO (все деньги — строки):
  - `ClosedTradeDto { tradeRef, channelId, channelTitle, symbol, side, avgEntry, exitPrice|null,
    realizedPnl, isWin|null, closeReason: 'tp'|'sl'|'manual'|'liquidation'|'cancelled'|null, leverage|null,
    openedAt, closedAt, durationMs, status: 'closed'|'cancelled' }`.
  - `PositionStatsDto` расширить: + `realizedPnl`, `totalPnl` (unrealised(open)+realized(closed)).
  - `ChannelPnlDto { channelId, channelTitle, openPositions, unrealisedPnl, realizedPnl, totalPnl, winRate }`.
  - `AccountWalletDto { totalEquity, availableBalance, currency, asOf|null, perChannel: ChannelPnlDto[] }`.
- **Commit:** `feat: DTO мониторинга + миграция wallet_snapshots`

### Task 2 — Backend: пагинация positions, /positions/history, расширенные stats, wallet
**Files:** `apps/api/src/positions/{positions.controller,positions.service}.ts`,
`apps/api/src/actions/actions.controller.ts` (курсор уже в сервисе — проверить контракт),
новый `apps/api/src/wallet/{wallet.controller,wallet.service,wallet.module}.ts`, `app.module.ts`.
- **Пагинация positions:** добавить `p.id` в SELECT; `@Query('limit','before')`; курсор `(updated_at,id)`
  как в `actions.service.ts`. Ответ — bare array. `hasMore` клиент считает по `length===limit`.
- **GET /positions/history** (закрытые): `trades WHERE status IN('closed','cancelled')`, join channels,
  keyset `(closed_at,id)` по `idx_trade_history`; фильтры `channel`, `status`. Причина закрытия — подзапрос
  последнего закрывающего `actions.type` по `trade_id` (liquidation > sl > tp > manual). exitPrice —
  взвеш. средняя из reduceOnly `executions` по trade_id (если считается легко; иначе null). → `ClosedTradeDto[]`.
- **Расширить getStats:** + `SUM(trades.realized_pnl)` closed, `totalPnl`. Новый `getStatsByChannel()`
  → `ChannelPnlDto[]` (GROUP BY channel_id, join title, winRate через существующий `formatWinRate`).
  Эндпоинт `GET /positions/stats` (расширенный) + `GET /positions/stats/by-channel`.
- **GET /account/wallet** (JwtGuard): последний `wallet_snapshots` (channel_id IS NULL) + `perChannel`
  (getStatsByChannel). → `AccountWalletDto`.
- Тесты api: пагинация (limit/before, порядок, hasMore), history (closed/cancelled, причина, фильтры,
  401), stats (realized/total/by-channel), wallet (последний снапшот + perChannel, 401).
- **Commit:** `feat: пагинация positions, история закрытых, PnL по каналам, wallet API`

### Task 3 — Engine: писатель wallet_snapshots + скрипт чистки фантомов
**Files:** `apps/engine/src/state/equity.ts` или новый `apps/engine/src/state/wallet-snapshot.ts`,
`apps/engine/src/main.ts` (планировщик записи), новый `scripts/cleanup-dryrun-positions.mjs`.
- **Писатель снапшотов:** в live периодически (напр. @Interval 30с или по wallet-топику private-ws)
  писать account-level `wallet_snapshots` из `getWalletBalance` (total_equity, available). channel_id=null.
  В dry_run — не писать (или писать константу; лучше не писать).
- **Скрипт чистки:** `scripts/cleanup-dryrun-positions.mjs` — для всех open/partially trades: `closeTrade`
  (status='closed', is_win остаётся null), `positions.size=0`, `symbol_ownership.released_at=now()`,
  открытые ордера → cancelled. ТОЛЬКО dry_run-хвост (order_link_id LIKE 'D%' или все, т.к. сейчас всё
  dry_run). Идемпотентный, с отчётом (сколько закрыто). НЕ трогает closed.
- Тесты engine: писатель формирует корректную строку снапшота (мок getWalletBalance); скрипт-логика
  (чистая функция) закрывает open и освобождает symbol_ownership, closed не трогает.
- **Commit:** `feat: писатель wallet_snapshots + скрипт чистки dry-run позиций`

### Task 4 — Frontend: пагинация, вкладки Open/Closed, панели PnL/баланс
**Files:** `apps/web/src/routes/{positions,actions}.tsx`, `apps/web/src/lib/ws.ts`,
новый `useCursorList`/`<LoadMore/>` (вынести из `MessageTimeline.tsx`),
новые компоненты `ClosedTradesTable`, `PnlPanel`/`WalletCard`.
- **Пагинация:** `positions.tsx` и `actions.tsx` → `useInfiniteQuery` + `<LoadMore/>`; realtime-инвалидации
  через `ws.ts`. Actions-бэкенд уже курсорный — только фронт.
- **Вкладки Open/Closed:** `SegmentedControl` над таблицей (`?status=` в URL). Closed → `ClosedTradesTable`
  из `GET /positions/history` (символ, сторона, вход, выход, realized PnL, причина TP/SL/manual, длит-ть,
  бейдж win/loss/cancelled).
- **Панели статистики:** глобальные карточки (realized/unrealised/total PnL) + баланс аккаунта
  (`GET /account/wallet`) + мини-таблица PnL по каналам. Стиль 1:1 с `buildStats`/`PendingOrders.tsx`.
- Тесты web: infinite «load more» рендерит вторую страницу; таб Closed показывает закрытые; панели PnL
  и баланс рендерят значения из DTO.
- **Commit:** `feat: пагинация, вкладки open/closed, панели PnL и баланса`

### Task 5 — Live-переключение + чистка + приёмка
- **Чистка:** прогнать `scripts/cleanup-dryrun-positions.mjs`, убедиться `positions size<>0 = 0`,
  open trades = 0.
- **Live:** `EXECUTION_MODE=live` в `.env`/docker-compose, пересобрать+перезапустить engine, убедиться:
  `reconcileOnStart` отработал, private-ws подключён, `wallet_snapshots` наполняется реальным equity,
  Positions зеркалят Bybit demo (сверить с `getPositions`). Реальный сигнал → реальный demo-ордер (или
  дождаться, или не форсировать — просто убедиться, что инфраструктура живая и баланс тянется).
- **Приёмка UI:** пагинация грузит ещё; Open/Closed переключается; PnL-панели и баланс показывают реальные
  значения с demo; per-channel PnL корректен. Скриншоты + SQL.
- **Адверсариал-ревью** всего диффа (workflow) + фиксы.
- **Commit:** `feat: мониторинг сделок — live на demo, PnL/баланс, пагинация, open/closed`
- Обновить `LOOP_STATE.md`.

## Definition of Done
- Actions и Positions пагинируются (load more / infinite).
- Вкладки Open/Closed; закрытые сделки с realized PnL и причиной.
- Рассинхрон устранён: движок live на demo, позиции = зеркало биржи, 0 фантомов.
- Статистика: глобальный и по-канальный PnL (realized+unrealised+total) + баланс аккаунта, реальные с demo.
- `pnpm test` + `pnpm typecheck` зелёные. Адверсариал-ревью пройден.
