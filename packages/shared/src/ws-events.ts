// Контракт realtime-событий (задача 9): общий и для api (сервер socket.io), и для будущего
// фронта (apps/web, Ф2+) — типы событий объявляются один раз здесь, а не дублируются на
// клиенте и сервере.
import type { Side } from './domain.js'
import type { ActionRowDto, MessageDto } from './dto.js'

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

/**
 * Задача 10: ЭТО и есть реальный Ф1-контракт (в отличие от Action*Payload выше, оставшихся
 * "целевой формой Ф2+", поскольку никакой код пока не читает их поля) — apps/engine/src/
 * pipeline.ts (emitPositionUpsert) и apps/engine/src/market-data/apply-tick.ts (живой тик
 * mark price) пишут в domain_events РОВНО эту форму, OutboxPublisher рассылает её как есть.
 * Фронт (lib/ws.ts: usePositionsStream/patchPositionRow) точечно патчит строку таблицы Positions
 * этими полями — unrealisedPnl/roi пересчитываются на клиенте из avgPrice/markPrice/size/side/
 * leverage форматированием shared/numbers.ts (formatDecimal/signedMoney/computeRoi) — той же
 * формулой, что и apps/api/src/positions/positions.service.ts (не тронут в этой задаче, его
 * приватные копии этих функций оставлены как есть — shared/numbers.ts здесь новый общий источник
 * только для фронта), чтобы точечный патч был визуально неотличим от обычного GET-ответа.
 */
export interface PositionUpsertPayload {
  channelId: number
  symbol: string
  side: Side | null
  size: string
  avgPrice: string | null
  markPrice: string | null
  leverage: string | null
  stopLoss: string | null
  tradeId: string | null
}

/**
 * Задача 3 (Ф3, приватный WS-мост Bybit apps/engine/src/bybit/private-ws.ts) — ПЕРВЫЙ реальный
 * продюсер этого события (тип существовал с задачи 8 как целевая форма для фронта, но до этой
 * задачи никто его не публиковал). `channelId` ДОБАВЛЕН здесь (в исходном черновике задачи 8 его
 * не было): apps/api/src/realtime/outbox.publisher.ts::publishRow ЖЁСТКО требует числовой
 * `payload.channelId`, иначе тихо пропускает рассылку строки (см. комментарий в файле) — без
 * этого поля position.close НИКОГДА не доехал бы до фронта.
 */
export interface PositionClosePayload {
  channelId: number
  symbol: string
  tradeRef: string | null
  realizedPnl: string
}

/**
 * Задача 3 (Ф3): приватный WS-мост Bybit публикует это на каждый пуш `order.linear` — статус
 * конкретного локального `orders` (entry/add/tp/sl/close), найденного по `orderLinkId`. Фронт
 * может точечно обновить бейдж статуса ордера без перезапроса всего списка.
 */
export interface OrderResolvedPayload {
  channelId: number
  tradeId: string | null
  symbol: string
  orderLinkId: string
  bybitOrderId: string | null
  status: string
}

export interface ServerToClientEvents {
  'message.new': (payload: MessageNewPayload) => void
  'message.updated': (payload: MessageUpdatedPayload) => void
  'channel.stats': (payload: ChannelStatsPayload) => void
  'action.new': (payload: ActionNewPayload) => void
  'action.skipped': (payload: ActionSkippedPayload) => void
  'position.upsert': (payload: PositionUpsertPayload) => void
  'position.close': (payload: PositionClosePayload) => void
  'order.resolved': (payload: OrderResolvedPayload) => void
}

export interface ClientToServerEvents {
  'channel.subscribe': (channelId: number) => void
  'channel.unsubscribe': (channelId: number) => void
}
