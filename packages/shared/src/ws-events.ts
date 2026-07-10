// Контракт realtime-событий (задача 9): общий и для api (сервер socket.io), и для будущего
// фронта (apps/web, Ф2+) — типы событий объявляются один раз здесь, а не дублируются на
// клиенте и сервере.
import type { ActionRowDto, MessageDto, PositionDto } from './dto.js'

export interface MessageNewPayload {
  channelId: number
  message: MessageDto
}

// Правка Telegram-сообщения (задача "правки в реальном времени"): та же форма, что и
// MessageNewPayload (channelId + собранный целиком MessageDto узла), — payload у обоих
// событий строится одним и тем же кодом на стороне ingest, различается только имя события.
export interface MessageUpdatedPayload {
  channelId: number
  message: MessageDto
}

export interface ChannelStatsPayload {
  channelId: number
  messageCount: number
  actionCount: number
}

// Задача 8 (спека §11): события таблиц Actions/Positions. Имена совпадают с тем, что реально
// пишет apps/engine/src/pipeline.ts в domain_events.type ('action.new', 'action.skipped',
// 'position.upsert') — OutboxPublisher (apps/api/src/realtime/outbox.publisher.ts) рассылает
// СТРОКУ domain_events.payload как есть, ничего не обогащая. Контракт ниже — целевая форма
// пейлоада для фронта (Ф2+); движок Ф1 публикует более узкий payload (actionId/messageId/type/
// symbol/side без channelName/иконки/join'ов) — обогащение payload'а до ActionRowDto/PositionDto
// в outbox не входит в объём задачи 8 (REST-слой), см. p1-task8-report.md «Сомнения».
export interface ActionNewPayload {
  channelId: number
  action: ActionRowDto
}

export interface ActionSkippedPayload {
  channelId: number
  action: ActionRowDto
}

export interface PositionUpsertPayload {
  position: PositionDto
}

export interface PositionClosePayload {
  symbol: string
  tradeRef: string | null
  realizedPnl: string
}

export interface ServerToClientEvents {
  'message.new': (payload: MessageNewPayload) => void
  'message.updated': (payload: MessageUpdatedPayload) => void
  'channel.stats': (payload: ChannelStatsPayload) => void
  'action.new': (payload: ActionNewPayload) => void
  'action.skipped': (payload: ActionSkippedPayload) => void
  'position.upsert': (payload: PositionUpsertPayload) => void
  'position.close': (payload: PositionClosePayload) => void
}

export interface ClientToServerEvents {
  'channel.subscribe': (channelId: number) => void
  'channel.unsubscribe': (channelId: number) => void
}
