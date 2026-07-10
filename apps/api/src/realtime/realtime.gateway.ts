import { Inject, Logger } from '@nestjs/common'
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import type { ServerToClientEvents, ClientToServerEvents } from 'shared/ws-events.js'
import { AuthService } from '../auth/auth.service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'

// Фронт (apps/web, Ф2+) поднимается на 5173 (Vite dev server) — тот же порт, что и у остальных
// dev-инструментов проекта.
const DEV_ORIGIN = 'http://localhost:5173'

function roomOf(channelId: number): string {
  return `channel:${channelId}`
}

/** Достаёт значение куки из сырого заголовка Cookie — socket.io отдаёт его строкой, а
 *  cookie-parser (используемый в HTTP-пайплайне) работает только как express-middleware
 *  и здесь недоступен. Парсер намеренно минимальный: нужно только значение SESSION_COOKIE. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

/**
 * Realtime-шлюз задачи 9: аутентификация той же кукой/JWT, что и REST (см. JwtGuard), комнаты
 * по каналам (channel:<id>) и метод emitToChannel для outbox.publisher.ts.
 */
@WebSocketGateway({
  cors: { origin: DEV_ORIGIN, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name)

  @WebSocketServer()
  private readonly server!: Server<ClientToServerEvents, ServerToClientEvents>

  // Явный @Inject — см. комментарий в auth.service.ts про design:paramtypes под vitest/esbuild.
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Тот же код проверки JWT, что и JwtGuard (AuthService.verifyToken) — невалидная/отсутствующая
   *  кука обрывает соединение сразу, без единого события клиенту, кроме disconnect. */
  async handleConnection(socket: Socket): Promise<void> {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE)
    if (!token) {
      socket.disconnect(true)
      return
    }

    try {
      await this.auth.verifyToken(token)
    } catch {
      // Просроченный/подделанный токен — тот же исход, что и отсутствие куки (см. JwtGuard).
      socket.disconnect(true)
    }
  }

  handleDisconnect(): void {
    // Состояния на подключение вне комнат socket.io нет — чистить нечего.
  }

  @SubscribeMessage('channel.subscribe')
  handleSubscribe(@ConnectedSocket() socket: Socket, @MessageBody() channelId: number): void {
    socket.join(roomOf(channelId))
  }

  @SubscribeMessage('channel.unsubscribe')
  handleUnsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() channelId: number): void {
    socket.leave(roomOf(channelId))
  }

  /** Вызывается из OutboxPublisher при разборе неопубликованных domain_events. event — рантайм-
   *  строка (domain_events.type), а не статический литерал ServerToClientEvents — поэтому payload
   *  типизирован как unknown: гарантия соответствия типу события лежит на продюсере (tg-ingest). */
  emitToChannel(channelId: number, event: keyof ServerToClientEvents, payload: unknown): void {
    this.server.to(roomOf(channelId)).emit(event, payload as never)
  }
}
