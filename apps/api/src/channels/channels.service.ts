import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import type { ChannelDto, MessageDto } from 'shared/dto.js'
import { DatabaseService } from '../db/database.service.js'

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
  cs.enabled, cs.trade_size, cs.max_leverage,
  (SELECT count(*) FROM actions   a WHERE a.channel_id = c.id)                 AS action_count,
  (SELECT count(*) FROM positions p WHERE p.channel_id = c.id AND p.size <> 0) AS active_positions,
  (SELECT count(*) FROM messages  m WHERE m.channel_id = c.id)                 AS message_count
`
const CHANNEL_FROM = `
  FROM channels c
  JOIN channel_settings cs ON cs.channel_id = c.id
`

function formatNumeric(value: string): string {
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

function toChannelDto(row: ChannelRow): ChannelDto {
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
    winRate: '—', // закрытых сделок ещё нет (Ф0)
    actionCount: row.action_count,
    activePositions: row.active_positions,
    messageCount: row.message_count,
    tradeSize: `$${formatNumeric(row.trade_size)}`,
    maxLeverage: `${formatNumeric(row.max_leverage)}x`,
  }
}

@Injectable()
export class ChannelsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listChannels(): Promise<ChannelDto[]> {
    const { rows } = await sql<ChannelRow>`
      SELECT ${sql.raw(CHANNEL_COLUMNS)}
      ${sql.raw(CHANNEL_FROM)}
      ORDER BY c.ord
    `.execute(this.database.db)
    return rows.map(toChannelDto)
  }

  async getChannel(id: number): Promise<ChannelDto | null> {
    const { rows } = await sql<ChannelRow>`
      SELECT ${sql.raw(CHANNEL_COLUMNS)}
      ${sql.raw(CHANNEL_FROM)}
      WHERE c.id = ${id}
    `.execute(this.database.db)
    return rows[0] ? toChannelDto(rows[0]) : null
  }

  async listMessages(channelId: number, limit: number, before?: number): Promise<MessageDto[]> {
    const clampedLimit = Math.max(1, Math.min(limit, MAX_MESSAGE_LIMIT))

    let query = this.database.db
      .selectFrom('messages')
      .select(['id', 'tg_message_id', 'msg_ts', 'text', 'ai_summary', 'method', 'media_kind'])
      .where('channel_id', '=', channelId)

    if (before !== undefined) {
      query = query.where('tg_message_id', '<', before)
    }

    const messages = await query.orderBy('tg_message_id', 'desc').limit(clampedLimit).execute()
    if (messages.length === 0) return []

    const mediaKindByMessageId = new Map(messages.map((m) => [m.id, m.media_kind]))
    const media = await this.database.db
      .selectFrom('message_media')
      .select(['id', 'message_id', 'media_type'])
      .where(
        'message_id',
        'in',
        messages.map((m) => m.id),
      )
      .orderBy('order_index', 'asc')
      .execute()

    const mediaByMessage = new Map<string, MessageDto['media']>()
    for (const row of media) {
      const kind = mediaKindOf(mediaKindByMessageId.get(row.message_id) ?? null, row.media_type)
      const list = mediaByMessage.get(row.message_id) ?? []
      list.push({ url: `/media/${row.id}`, kind })
      mediaByMessage.set(row.message_id, list)
    }

    return messages.map((m) => ({
      id: m.id,
      tgMessageId: m.tg_message_id,
      time: m.msg_ts.toISOString(),
      text: m.text,
      media: mediaByMessage.get(m.id) ?? [],
      aiSummary: m.ai_summary,
      actions: [], // Ф0: пайплайн actions ещё не реализован
      method: m.method as MessageDto['method'],
    }))
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
