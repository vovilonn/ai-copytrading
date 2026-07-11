// DTO, общие для API и будущего фронта (apps/web, Ф2+). Ровно как в брифе задачи 8
// (.superpowers/sdd/task-8-brief.md) — типы контракта, а не доменная модель БД.
import type { ActionType, OrderPurpose, Side } from './domain.js'

export interface ChannelDto {
  id: number
  key: string
  title: string
  handle: string
  initial: string
  status: 'active' | 'paused' | 'error'
  copyEnabled: boolean
  // Win Rate (Ф4, task-2-brief.md): round(wins/closedTrades*100) + '%' по закрытым сделкам
  // канала (apps/api/src/channels/stats.service.ts); '—' — закрытых сделок ещё нет.
  winRate: string
  actionCount: number
  activePositions: number
  messageCount: number
  tradeSize: string
  maxLeverage: string
  // Задача "редактируемые настройки канала" (Ф4): та же строковая конвенция форматирования,
  // что и у tradeSize/maxLeverage выше ('5x'), null — сигнал не задаёт плечо (используется
  // maxLeverage сигнала как есть). Settings-таб (design/project/Admin.dc.html:280-289).
  defaultLeverage: string | null
  crossMargin: boolean
}

// Задача "редактируемые настройки канала" (Ф4): ответ PATCH /api/channels/:id/settings
// (apps/api/src/channels/channel-settings.controller.ts) — полный снимок channel_settings
// после обновления, в том же строковом форматировании денег/плеча, что и ChannelDto
// ('$500', '10x'), чтобы фронт мог применить его к кэшу ['channel', id]/['channels'] без
// дополнительного парсинга.
export interface ChannelSettingsDto {
  channelId: number
  enabled: boolean
  tradeSize: string
  maxLeverage: string
  defaultLeverage: string | null
  crossMargin: boolean
}

// Задача 8: теперь actions пайплайна (задача 7) реально заполняют это поле — реализация в
// apps/api/src/channels/channels.service.ts. Форма выведена из design/project/Admin.dc.html
// (блок под сообщением: иконка типа + пара + ссылка на сделку) и action_type/side_t из
// apps/api/src/db/migrations/001_initial.ts. `type` — полный ActionType (12 значений, shared/
// domain.ts), а не подмножество из 4-х, которые рисует прототип, — реальные actions в БД
// приходят всех 12 видов (напр. modify_sl/tp_hit — см. dev-данные канала 2088626562).
export interface MessageActionDto {
  type: ActionType
  side: Side | null
  pair: string | null
  tradeRef: string | null // '#TR-xxxx' или null, если сигнал пропущен (Skipped)
  skipReason: string | null
  icon: string // lucide-имя (спека §12, packages/shared/src/action-meta.ts)
}

export interface MessageDto {
  id: string
  tgMessageId: number
  time: string // ISO-строка msg_ts
  text: string
  media: { url: string; kind: 'photo' | 'video-thumb' }[]
  aiSummary: string | null
  actions: MessageActionDto[] // Ф1: заполняется из actions пайплайна (задача 7), [] — нет сигнала
  method: 'auto' | 'ai' | 'review' | null
}

// Задача 8: строка таблицы Actions (design/project/Admin.dc.html:306-392) — один action = одна
// строка, свежие сверху (GET /api/actions). `short`/`summary`/`icon`/`iconColor` — уже готовый
// к рендеру вид (см. packages/shared/src/action-meta.ts), а не сырые type/side/pct: фронт этой
// фазы не должен знать маппинг типов действий в иконки/подписи — это забота backend.
export interface ActionRowDto {
  id: string
  type: ActionType
  side: Side | null
  short: string // короткая подпись типа ('Open', 'Partial TP', ...)
  pair: string | null
  summary: string // 'Open position' / 'Partial take-profit · 50%'
  tradeRef: string | null // '#TR-1042' или null (сделки ещё нет — напр. на skipped-action)
  channelId: number
  channelName: string
  channelInitial: string
  time: string // ISO actions.created_at
  // Ф1 (CH1-адаптер) публикует только 'auto' — actions.method хранится строкой в БД
  // (см. apps/api/src/db/database.ts), 'review' появится вместе с AI-слоем (Ф2).
  method: 'auto' | 'ai'
  skipReason: string | null
  icon: string // lucide-имя
  iconColor: string
}

// Задача 8: строка таблицы Positions (design/project/Admin.dc.html:394-475) — зеркало
// Bybit /v5/position/list (таблица `positions`, size<>0). Деньги/цены — строки.
export interface PositionDto {
  symbol: string
  side: Side
  size: string
  entry: string
  mark: string
  liq: string | null // не всегда рассчитана биржей (nullable в БД)
  unrealisedPnl: string // '+$327.60' — 0, пока не подключён живой тикер-фид (задача 10)
  roi: string // '+6.2%'
  tp: string | null // TP-лесенка сворачивается в ближайшую/последнюю цель — здесь не хранится
  sl: string | null
  leverage: string // '5x'
  marginMode: 'Cross' | 'Isolated'
  source: string // имя канала-владельца
  tradeRef: string | null // '#TR-1042'
  channelId: number
}

// Task 1 (мониторинг PnL/баланса, docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md):
// realizedPnl/totalPnl добавлены поверх исходных Ф1-полей (openPositions/unrealisedPnl/
// positionValue/marginUsed остались как есть — старые потребители не ломаются). totalPnl =
// unrealisedPnl(open) + realizedPnl(closed) — реальный расчёт в Task 2 (apps/api/src/positions/
// positions.service.ts::getStats), здесь только форма контракта.
export interface PositionStatsDto {
  openPositions: number
  unrealisedPnl: string
  positionValue: string
  marginUsed: string
  realizedPnl: string
  totalPnl: string
}

// Задача 3 (Ф4, task-3-brief.md): отложенные лимитки на вход — submitted limit-ордера
// purpose IN ('entry','add') с reduce_only=false (apps/api/src/orders/pending.service.ts).
// TP/SL — тоже limit-ордера, но reduce_only=true и без TTL-свипа (протекторы уже открытой
// позиции, design spec §9) — на этот экран не попадают, они уже показаны на Positions.
export interface PendingOrderDto {
  id: string
  symbol: string
  side: Side
  // Полный OrderPurpose (не сузили до 'entry'|'add' литералом) — тот же DRY-приём, что и
  // ActionRowDto.type/MessageActionDto.type: фильтр значений — забота backend-запроса
  // (WHERE purpose IN ('entry','add')), а не сужение типа контракта.
  purpose: OrderPurpose
  price: string
  qty: string
  channelId: number
  channelTitle: string
  tradeRef: string | null
  orderLinkId: string
  createdAt: string // ISO orders.created_at
  submittedAt: string | null // ISO orders.submitted_at
  // ЭФФЕКТИВНЫЙ дедлайн TTL-свипа (apps/engine/src/main.ts::sweepExpiredLimitOrders) — ISO-строка,
  // ВСЕГДА определена: COALESCE(orders.ttl_expires_at, orders.created_at + channel_settings.
  // limit_ttl_sec), а не голая (обычно NULL — движок никогда явно её не проставляет при
  // вставке ордера) колонка orders.ttl_expires_at. Фронт считает обратный отсчёт до этого момента.
  ttlExpiresAt: string
}

// Task 1 (мониторинг PnL/баланса, docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md):
// строка вкладки Closed на Positions — GET /positions/history (Task 2). Источник — ЗАКРЫТЫЕ
// `trades` (status IN ('closed','cancelled')), НЕ `positions` (те — только открытые, зеркало
// биржи). exitPrice/closeReason nullable: закрытие может быть не до конца восстановимо
// (напр. cancelled-сделка без исполнений вообще не имеет exitPrice/причины закрытия).
export interface ClosedTradeDto {
  tradeRef: string // human_ref ('TR-1042'), как и tradeRef в PositionDto/ActionRowDto
  channelId: number
  channelTitle: string
  symbol: string
  side: Side
  avgEntry: string
  exitPrice: string | null
  realizedPnl: string
  isWin: boolean | null
  // Причина закрытия — из actions (последний закрывающий action.type по trade_id, приоритет
  // liquidation > sl > tp > manual, см. план Task 2); 'cancelled' — отдельный статус/бейдж,
  // не путать с причиной закрытия ОТКРЫТОЙ сделки.
  closeReason: 'tp' | 'sl' | 'manual' | 'liquidation' | 'cancelled' | null
  leverage: string | null
  openedAt: string // ISO trades.opened_at
  closedAt: string // ISO trades.closed_at
  durationMs: number // closedAt - openedAt, посчитано на backend
  status: 'closed' | 'cancelled'
}

// Task 1: PnL по одному каналу — GET /positions/stats/by-channel (Task 2), строка мини-таблицы
// PnL-панели (Task 4). winRate — тот же формат, что и ChannelDto.winRate ('73%' / '—').
export interface ChannelPnlDto {
  channelId: number
  channelTitle: string
  openPositions: number
  unrealisedPnl: string
  realizedPnl: string
  totalPnl: string
  winRate: string
}

// Task 1: баланс demo-аккаунта — GET /account/wallet (Task 2), источник — последний
// `wallet_snapshots` (channel_id IS NULL), который пишет движок (Task 3). asOf=null — движок
// ещё не записал ни одного снапшота (напр. только что переключились на live) — фронт должен
// показать состояние "нет данных", а не нулевой баланс.
export interface AccountWalletDto {
  totalEquity: string
  availableBalance: string
  currency: string
  asOf: string | null // ISO wallet_snapshots.created_at последнего снапшота
  perChannel: ChannelPnlDto[]
}

// Ф4 задача 5 (метрики/наблюдаемость, p4-task5-brief.md): GET /api/metrics/ai
// (apps/api/src/metrics/metrics.controller.ts) — единственная форма наблюдаемости этой задачи
// (дизайн-навигация не содержит отдельного экрана метрик, см. бриф — сознательно НЕ добавлен
// новый UI-роут). Читает apps/api/src/db/database.ts::ai_calls (не типизирована в Kysely DB —
// сырой sql, см. metrics.service.ts) + типизированные actions/trades.

/** Строка агрегата по одной модели (ai_calls.model, напр. 'claude-sonnet-4-5-20250929'). */
export interface AiModelMetricsDto {
  model: string
  calls: number
  // Доля [0..1], не строка '73%' — API-контракт, форматирование (если понадобится) на клиенте;
  // текущий потребитель — scripts/metrics.mjs — форматирует сам при печати.
  cacheHitRate: number
  escalations: number
  avgLatencyMs: number
  p50LatencyMs: number
  p95LatencyMs: number
  // Деньги — строка (конвенция всего DTO-контракта, см. ChannelDto.tradeSize и т.п.), '$0.0231'.
  totalCostUsd: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export interface AiMetricsDto {
  totalCalls: number
  byModel: AiModelMetricsDto[]
  totalCostUsd: string
  cacheHitRate: number
  // count(ai_calls.error IS NOT NULL) — неудачные вызовы (сетевые ошибки/5xx/невалидный ответ).
  errors: number
}

// actions.status='executed' — исполнено; actions.skip_reason IS NOT NULL — пропущено (причина);
// это НЕ дополняющие друг друга подмножества всех actions.status (есть ещё pending/executing/
// failed/needs_review без skip_reason) — total даёт полный размер таблицы для контекста.
export interface ActionsMetricsDto {
  total: number
  executed: number
  skipped: number
  bySkipReason: Record<string, number>
}

// Опционально по брифу задачи 5 ("если легко — не дублируя сложную логику"): переиспользует ТУ ЖЕ
// формулу Win Rate, что и apps/api/src/channels/stats.service.ts (packages/shared/src/numbers.ts
// formatWinRate), но без фильтра по каналу — сводка по ВСЕМ каналам сразу.
export interface TradesMetricsDto {
  open: number
  closed: number
  cancelled: number
  winRate: string
}

export interface MetricsDto {
  ai: AiMetricsDto
  actions: ActionsMetricsDto
  trades: TradesMetricsDto
}
