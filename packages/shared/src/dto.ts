// DTO, общие для API и будущего фронта (apps/web, Ф2+). Ровно как в брифе задачи 8
// (.superpowers/sdd/task-8-brief.md) — типы контракта, а не доменная модель БД.
import type { ActionType, Side } from './domain.js'

export interface ChannelDto {
  id: number
  key: string
  title: string
  handle: string
  initial: string
  status: 'active' | 'paused' | 'error'
  copyEnabled: boolean
  winRate: string // '—' пока нет закрытых сделок
  actionCount: number
  activePositions: number
  messageCount: number
  tradeSize: string
  maxLeverage: string
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

export interface PositionStatsDto {
  openPositions: number
  unrealisedPnl: string
  positionValue: string
  marginUsed: string
}
