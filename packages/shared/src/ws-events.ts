// Контракт realtime-событий (задача 9): общий и для api (сервер socket.io), и для будущего
// фронта (apps/web, Ф2+) — типы событий объявляются один раз здесь, а не дублируются на
// клиенте и сервере.
import type { MessageDto } from './dto.js'

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

export interface ServerToClientEvents {
  'message.new': (payload: MessageNewPayload) => void
  'message.updated': (payload: MessageUpdatedPayload) => void
  'channel.stats': (payload: ChannelStatsPayload) => void
}

export interface ClientToServerEvents {
  'channel.subscribe': (channelId: number) => void
  'channel.unsubscribe': (channelId: number) => void
}
