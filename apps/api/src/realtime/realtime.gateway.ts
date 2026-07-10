import { Inject, Logger } from '@nestjs/common'
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
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
export class RealtimeGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name)

  @WebSocketServer()
  private readonly server!: Server<ClientToServerEvents, ServerToClientEvents>

  // Явный @Inject — см. комментарий в auth.service.ts про design:paramtypes под vitest/esbuild.
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Проверка куки/JWT перенесена в middleware хендшейка (io.use): раньше она жила в
   *  handleConnection и выполнялась уже ПОСЛЕ установления соединения — окно TOCTOU, в котором
   *  @SubscribeMessage('channel.subscribe') формально активен до socket.disconnect(true).
   *  next(new Error(...)) в middleware не даёт соединению установиться вовсе — обработчики
   *  сообщений сокета для неаутентифицированного клиента никогда не регистрируются. */
  afterInit(server: Server<ClientToServerEvents, ServerToClientEvents>): void {
    server.use((socket, next) => {
      const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE)
      if (!token) {
        next(new Error('unauthorized'))
        return
      }

      this.auth
        .verifyToken(token)
        .then(() => next())
        .catch(() => {
          // Просроченный/подделанный токен — тот же исход, что и отсутствие куки (см. JwtGuard).
          next(new Error('unauthorized'))
        })
    })
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
