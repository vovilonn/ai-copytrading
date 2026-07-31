import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { actionIcon } from 'shared/action-meta.js'
import type { ChannelDto, MessageActionDto, MessageDto, MessageStatus } from 'shared/dto.js'
import { mediaUrl } from 'shared/media.js'
import { formatWinRate } from 'shared/numbers.js'
import { DatabaseService } from '../db/database.service.js'
import { ChannelStatsService } from './stats.service.js'

export const DEFAULT_MESSAGE_LIMIT = 50
export const MAX_MESSAGE_LIMIT = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ChannelRow {
  id: number
  key: string
  title: string | null
  handle: string | null
  status: 'active' | 'paused' | 'error'
  enabled: boolean
  trade_size: string
  max_leverage: string
  default_leverage: string | null
  cross_margin: boolean
  force_trade_size: boolean
  action_count: number
  active_positions: number
  message_count: number
}

// Общие для listChannels/getChannel части запроса вынесены в константы и склеены через
// sql.raw — сам текст статичен (без пользовательского ввода), поэтому raw безопасен, а id
// в WHERE ниже остаётся обычным биндом параметра.
// actions/positions ещё не заведены в DB-типах database.ts (см. комментарий там же) — считаем
// их сырым SQL, а не Kysely-билдером, одним запросом с коррелированными подзапросами (не N+1).
const CHANNEL_COLUMNS = `
  c.id, c.key, c.title, c.handle, c.status,
  cs.enabled, cs.trade_size, cs.max_leverage, cs.default_leverage, cs.cross_margin, cs.force_trade_size,
  (SELECT count(*) FROM actions   a WHERE a.channel_id = c.id)                 AS action_count,
  (SELECT count(*) FROM positions p WHERE p.channel_id = c.id AND p.size <> 0) AS active_positions,
  (SELECT count(*) FROM messages  m WHERE m.channel_id = c.id)                 AS message_count
`
const CHANNEL_FROM = `
  FROM channels c
  JOIN channel_settings cs ON cs.channel_id = c.id
`

// Экспортирована для переиспользования в channel-settings.service.ts (тот же вид форматирования
// нужен и для ChannelSettingsDto, DRY — не дублируем String(Number(...)) в двух файлах).
export function formatNumeric(value: string): string {
  // NUMERIC приходит строкой вида '500.00000000' — для отображения обрезаем незначащие нули
  // (design/project/Admin.dc.html показывает '$500', '10x', а не '$500.00000000').
  // String(Number(...)) уже сам не печатает лишние нули/точку для целых значений.
  return String(Number(value))
}

function mediaKindOf(messageMediaKind: string | null, mediaType: string): 'photo' | 'video-thumb' {
  // Сейчас все скачанные файлы — image/jpeg (в т.ч. превью видео, см. apps/tg-ingest/src/media.ts),
  // поэтому media_type сам по себе видео не покажет — единственный текущий сигнал video-thumb —
  // messages.media_kind ('MessageMediaDocument' — единственный случай, когда pickMedia скачивает
  // видео-превью). mediaType.startsWith('video/') оставлен на будущее, если ingest когда-нибудь
  // начнёт сохранять настоящий видео-mime.
  if (mediaType.startsWith('video/')) return 'video-thumb'
  if (messageMediaKind === 'MessageMediaDocument') return 'video-thumb'
  return 'photo'
}

// Win Rate (Ф4, task-2-brief.md): передаётся вызывающим кодом (listChannels/getChannel) —
// сама toChannelDto не ходит в БД, чтобы остаться чистой функцией форматирования строки (та же
// причина, по которой формула округления/пустого состояния вынесена в stats.service.ts, а не
// дублируется здесь).
function toChannelDto(row: ChannelRow, winRate: string): ChannelDto {
  const title = row.title ?? row.key
  return {
    id: row.id,
    key: row.key,
    title,
    // Приватные каналы/форумы не имеют username → channels.handle пуст. Фолбэк — «#<id>»
    // (id канала — это же «сырой» Telegram id, см. packages/shared/src/sources.ts), чтобы
    // моноширинная строка под названием никогда не была пустой (design/project/Admin.dc.html:184).
    handle: row.handle ?? `#${row.id}`,
    initial: title.charAt(0).toUpperCase(),
    status: row.status,
    copyEnabled: row.enabled,
    winRate,
    actionCount: row.action_count,
    activePositions: row.active_positions,
    messageCount: row.message_count,
    tradeSize: `$${formatNumeric(row.trade_size)}`,
    maxLeverage: `${formatNumeric(row.max_leverage)}x`,
    defaultLeverage: row.default_leverage !== null ? `${formatNumeric(row.default_leverage)}x` : null,
    crossMargin: row.cross_margin,
    forceTradeSize: row.force_trade_size,
  }
}

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ChannelStatsService) private readonly stats: ChannelStatsService,
  ) {}

  async listChannels(): Promise<ChannelDto[]> {
    const { rows } = await sql<ChannelRow>`
      SELECT ${sql.raw(CHANNEL_COLUMNS)}
      ${sql.raw(CHANNEL_FROM)}
      ORDER BY c.ord
    `.execute(this.database.db)
    // Один доп. запрос на ВЕСЬ список (winRatesForAll — GROUP BY channel_id), не N+1 по каналам.
    const winRates = await this.stats.winRatesForAll()
    return rows.map((row) => toChannelDto(row, winRates.get(row.id) ?? formatWinRate(0, 0)))
  }

  async getChannel(id: number): Promise<ChannelDto | null> {
    const { rows } = await sql<ChannelRow>`
      SELECT ${sql.raw(CHANNEL_COLUMNS)}
      ${sql.raw(CHANNEL_FROM)}
      WHERE c.id = ${id}
    `.execute(this.database.db)
    const row = rows[0]
    if (!row) return null
    const winRate = await this.stats.winRateFor(id)
    return toChannelDto(row, winRate)
  }

  async listMessages(channelId: number, limit: number, before?: number): Promise<MessageDto[]> {
    const clampedLimit = Math.max(1, Math.min(limit, MAX_MESSAGE_LIMIT))

    // Telegram доставляет альбом N отдельными строками messages с общим grouped_id (задача
    // 12c) — таймлайн должен рисовать альбом ОДНИМ узлом с несколькими фото, а не N плитками
    // по одной фотографии. Узел таймлайна = coalesce(grouped_id, id::text): для одиночного
    // сообщения это его собственный id (группа из одной строки), для альбома — общий grouped_id.
    // Якорь узла — сообщение с МИНИМАЛЬНЫМ tg_message_id в группе: Telegram выдаёт участникам
    // одного альбома подряд идущие id одним пакетом, поэтому диапазоны id разных узлов никогда
    // не перемешиваются — фильтр `tg_message_id < before` по минимуму группы остаётся
    // монотонной пагинацией, как и для одиночных сообщений.
    // `limit` — количество УЗЛОВ таймлайна (альбомов), а не строк messages, поэтому лимитируем
    // именно на этом шаге, до разворачивания групп в строки.
    const beforeClause = before !== undefined ? sql`AND tg_message_id < ${before}` : sql``
    const { rows: nodes } = await sql<{ node_key: string; anchor_tg_message_id: number }>`
      SELECT coalesce(grouped_id, id::text) AS node_key, min(tg_message_id) AS anchor_tg_message_id
      FROM messages
      WHERE channel_id = ${channelId}
      ${beforeClause}
      GROUP BY coalesce(grouped_id, id::text)
      ORDER BY anchor_tg_message_id DESC
      LIMIT ${clampedLimit}
    `.execute(this.database.db)
    if (nodes.length === 0) return []

    // Строки messages, входящие в отобранные узлы (для альбома — несколько строк с одним
    // grouped_id: нужны все подписи группы, для одиночного — ровно одна строка).
    return this.buildMessageNodes(channelId, nodes)
  }

  /**
   * Один узел таймлайна по id сообщения. Нужен реалтайму: движок дописывает действия и AI-саммари
   * УЖЕ ПОСЛЕ того, как сообщение прилетело по WS от tg-ingest, — outbox (realtime/outbox.publisher.ts)
   * пересобирает узел этим методом и рассылает 'message.updated', чтобы таймлайн обновился на месте,
   * а не только после перезагрузки страницы.
   */
  async getMessageNode(channelId: number, messageId: string): Promise<MessageDto | null> {
    if (!UUID_RE.test(messageId)) return null // messages.id — UUID; мусор не роняем в 22P02

    const { rows: nodes } = await sql<{ node_key: string; anchor_tg_message_id: number }>`
      SELECT coalesce(grouped_id, id::text) AS node_key, min(tg_message_id) AS anchor_tg_message_id
      FROM messages
      WHERE channel_id = ${channelId}
        AND coalesce(grouped_id, id::text) = (
          SELECT coalesce(grouped_id, id::text) FROM messages WHERE id = ${messageId}::uuid
        )
      GROUP BY coalesce(grouped_id, id::text)
    `.execute(this.database.db)
    if (nodes.length === 0) return null

    const built = await this.buildMessageNodes(channelId, nodes)
    return built[0] ?? null
  }

  /** Общая сборка узлов таймлайна (альбом = один узел) — из listMessages и getMessageNode. */
  private async buildMessageNodes(
    channelId: number,
    nodes: readonly { node_key: string; anchor_tg_message_id: number }[],
  ): Promise<MessageDto[]> {
    const nodeKeys = nodes.map((n) => n.node_key)
    const { rows: messageRows } = await sql<{
      id: string
      tg_message_id: number
      msg_ts: Date
      text: string
      ai_summary: string | null
      method: string | null
      media_kind: string | null
      grouped_id: string | null
      status: MessageStatus
      status_reason: string | null
    }>`
      SELECT id, tg_message_id, msg_ts, text, ai_summary, method, media_kind, grouped_id, status, status_reason
      FROM messages
      WHERE channel_id = ${channelId}
        AND coalesce(grouped_id, id::text) = ANY(${nodeKeys})
      ORDER BY tg_message_id ASC
    `.execute(this.database.db)
    if (messageRows.length === 0) return []

    const mediaKindByMessageId = new Map(messageRows.map((m) => [m.id, m.media_kind]))
    const media = await this.database.db
      .selectFrom('message_media')
      .select(['id', 'message_id', 'media_type'])
      .where(
        'message_id',
        'in',
        messageRows.map((m) => m.id),
      )
      .orderBy('order_index', 'asc')
      .execute()

    const mediaByMessage = new Map<string, MessageDto['media']>()
    for (const row of media) {
      const kind = mediaKindOf(mediaKindByMessageId.get(row.message_id) ?? null, row.media_type)
      const list = mediaByMessage.get(row.message_id) ?? []
      list.push({ url: mediaUrl(row.id), kind })
      mediaByMessage.set(row.message_id, list)
    }

    // Задача 8: actions пайплайна (задача 7) для показанных сообщений — один батч-запрос на
    // все узлы страницы (тот же приём, что и с message_media выше, не N+1). LEFT JOIN trades —
    // tradeRef (у skipped-actions trade_id всегда null).
    const actionRows = await this.database.db
      .selectFrom('actions as a')
      .leftJoin('trades as t', 't.id', 'a.trade_id')
      .select([
        'a.message_id as message_id',
        'a.action_index as action_index',
        'a.type as type',
        'a.side as side',
        'a.pair as pair',
        'a.skip_reason as skip_reason',
        't.human_ref as human_ref',
        // Цены реально выставленных ордеров этого действия — см. MessageActionDto.placedOrders.
        sql<string | null>`(
          SELECT string_agg(DISTINCT o.purpose || ' ' || trim(trailing '.' from trim(trailing '0' from o.price::text)), ', ')
            FROM orders o
           WHERE o.action_id = a.id AND o.purpose IN ('tp','sl') AND o.price IS NOT NULL
             AND o.status <> 'cancelled'
        )`.as('placed_orders'),
      ])
      .where(
        'a.message_id',
        'in',
        messageRows.map((m) => m.id),
      )
      .orderBy('a.action_index', 'asc')
      .execute()

    const actionsByMessage = new Map<string, MessageActionDto[]>()
    for (const row of actionRows) {
      const dto: MessageActionDto = {
        type: row.type,
        side: row.side,
        pair: row.pair,
        tradeRef: row.human_ref ? `#${row.human_ref}` : null,
        skipReason: row.skip_reason,
        icon: actionIcon(row.type, row.side),
        placedOrders: row.placed_orders,
      }
      const list = actionsByMessage.get(row.message_id) ?? []
      list.push(dto)
      actionsByMessage.set(row.message_id, list)
    }

    // Строки, сгруппированные по узлу таймлайна (сохраняют порядок возрастания tg_message_id
    // из запроса выше — важно: первый элемент группы и есть её якорь).
    const rowsByNode = new Map<string, typeof messageRows>()
    for (const row of messageRows) {
      const key = row.grouped_id ?? row.id
      const list = rowsByNode.get(key) ?? []
      list.push(row)
      rowsByNode.set(key, list)
    }

    const result: MessageDto[] = []
    for (const node of nodes) {
      const groupRows = rowsByNode.get(node.node_key)
      if (!groupRows || groupRows.length === 0) continue // гонка между двумя запросами — пропускаем узел, а не 500
      const anchor = groupRows[0]! // отсортированы по возрастанию tg_message_id — первый и есть якорь (min)
      // Подпись Telegram лежит ровно на одном элементе альбома (иногда её нет вовсе) —
      // берём первую непустую по порядку id, а не только якоря.
      const text = groupRows.map((r) => r.text).find((t) => t.trim().length > 0) ?? ''

      result.push({
        id: anchor.id,
        tgMessageId: anchor.tg_message_id,
        time: anchor.msg_ts.toISOString(),
        text,
        media: groupRows.flatMap((r) => mediaByMessage.get(r.id) ?? []),
        aiSummary: anchor.ai_summary,
        actions: groupRows.flatMap((r) => actionsByMessage.get(r.id) ?? []),
        method: anchor.method as MessageDto['method'],
        status: anchor.status,
        statusReason: anchor.status_reason,
      })
    }
    return result
  }

  async getMedia(id: string): Promise<{ storagePath: string; mediaType: string } | null> {
    // message_media.id — UUID: без этой проверки Postgres кидает 22P02 (invalid input syntax
    // for type uuid) на произвольную строку в URL, и запрос падал бы 500 вместо 404.
    if (!UUID_RE.test(id)) return null

    const row = await this.database.db
      .selectFrom('message_media')
      .select(['storage_path', 'media_type'])
      .where('id', '=', id)
      .executeTakeFirst()
    return row ? { storagePath: row.storage_path, mediaType: row.media_type } : null
  }
}
