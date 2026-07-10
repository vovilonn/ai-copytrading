// Контракт realtime-событий (задача 9): общий и для api (сервер socket.io), и для будущего
// фронта (apps/web, Ф2+) — типы событий объявляются один раз здесь, а не дублируются на
// клиенте и сервере.
import type { MessageDto } from './dto.js'

export interface MessageNewPayload {
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
  'channel.stats': (payload: ChannelStatsPayload) => void
}

export interface ClientToServerEvents {
  'channel.subscribe': (channelId: number) => void
  'channel.unsubscribe': (channelId: number) => void
}
