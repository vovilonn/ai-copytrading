import { Kysely, sql } from 'kysely'
import type { DB } from 'api/db/database.js'

export interface IngestMessage {
  channelId: number
  tgMessageId: number
  // Опциональны: тесты и вызывающий код (пока не написан парсер) заполняют не все поля сразу
  // (например бэкфилл ещё не знает topicId/groupedId) — дефолты соответствуют колонкам схемы.
  topicId?: number | null
  groupedId?: string | null
  replyToMsgId?: number | null
  replyToTopId?: number | null
  isTopicMessage?: boolean
  text: string
  hasMedia?: boolean
  mediaKind?: string | null
  msgTs: Date
  editedTs?: Date | null
  raw: unknown
}

export async function saveMessage(
  db: Kysely<DB>,
  input: IngestMessage,
): Promise<{ id: string; inserted: boolean }> {
  const editedTs = input.editedTs ?? null
  const isEdit = editedTs != null

  const row = await db
    .insertInto('messages')
    .values({
      channel_id: input.channelId,
      tg_message_id: input.tgMessageId,
      topic_id: input.topicId ?? null,
      grouped_id: input.groupedId ?? null,
      reply_to_msg_id: input.replyToMsgId ?? null,
      reply_to_top_id: input.replyToTopId ?? null,
      is_topic_message: input.isTopicMessage ?? false,
      text: input.text,
      has_media: input.hasMedia ?? false,
      media_kind: input.mediaKind ?? null,
      msg_ts: input.msgTs,
      edited_ts: editedTs,
      raw: JSON.stringify(input.raw),
    })
    .onConflict((oc) =>
      isEdit
        ? oc.columns(['channel_id', 'tg_message_id']).doUpdateSet((eb) => ({
            text: input.text,
            edited_ts: editedTs,
            edit_count: eb('messages.edit_count', '+', 1),
          }))
        : // Повторная доставка — не ошибка: catchUp() в GramJS ничего не делает,
          // сообщение может продиспатчиться дважды, а бэкфилл на границе
          // перекрывается с live-потоком (см. docs/superpowers/research/telegram-ingestion.md §5).
          oc.columns(['channel_id', 'tg_message_id']).doNothing(),
    )
    .returning(['id'])
    .executeTakeFirst()

  if (row) return { id: row.id, inserted: !isEdit }

  const existing = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', input.channelId)
    .where('tg_message_id', '=', input.tgMessageId)
    .executeTakeFirstOrThrow()

  return { id: existing.id, inserted: false }
}

export async function advanceCursor(
  db: Kysely<DB>,
  channelId: number,
  tgMessageId: number,
): Promise<void> {
  // Бэкфилл и live-поток пересекаются на границе и могут прислать старый id —
  // курсор двигаем только вперёд (GREATEST), откатывать нельзя.
  await db
    .updateTable('channels')
    .set({ last_seen_message_id: sql<number>`GREATEST(last_seen_message_id, ${tgMessageId})` })
    .where('id', '=', channelId)
    .execute()
}

export async function getCursor(db: Kysely<DB>, channelId: number): Promise<number> {
  const row = await db
    .selectFrom('channels')
    .select('last_seen_message_id')
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow()
  return Number(row.last_seen_message_id)
}
