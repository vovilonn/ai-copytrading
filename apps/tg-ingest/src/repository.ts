import crypto from 'node:crypto'
import { Kysely, sql } from 'kysely'
import type { DB } from 'api/db/database.js'

export interface IngestMessage {
  // Опционален: если не задан, генерируется здесь же (crypto.randomUUID()) — тот же приём,
  // что и у messages.id DEFAULT gen_random_uuid() в схеме, но вычисленный на стороне JS, чтобы
  // вызывающий код (saveMessageWithEvent) знал итоговый id ДО коммита транзакции и мог положить
  // его в payload события domain_events.
  id?: string
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
      id: input.id ?? crypto.randomUUID(),
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
    // ВАЖНО: isEdit — это "входящее сообщение несёт editDate", а не "в БД уже была строка".
    // У ~сообщений топика editDate НЕ null уже на первом же появлении (правки Telegram-канала
    // до того, как мы вообще увидели сообщение) — если считать inserted=!isEdit, такие первые
    // вставки ошибочно давали бы inserted=false и молча теряли бы outbox-событие (задача 9).
    // xmax=0 — стандартный приём Postgres: у строки, вставленной ИМЕННО этой командой (а не
    // задетой веткой ON CONFLICT DO UPDATE), xmax остаётся нулевым независимо от значения isEdit.
    .returning(['id', sql<boolean>`(xmax = 0)`.as('inserted')])
    .executeTakeFirst()

  if (row) return { id: row.id, inserted: row.inserted }

  const existing = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', input.channelId)
    .where('tg_message_id', '=', input.tgMessageId)
    .executeTakeFirstOrThrow()

  return { id: existing.id, inserted: false }
}

export interface IngestMediaInput {
  id: string
  tgMessageId: number
  groupedId: string | null
  orderIndex: number
  storagePath: string
  mediaType: string
  bytes: number
  sha256: string | null
}

export interface DomainEventInput {
  type: string
  aggregate: string
  payload: unknown
}

/**
 * Транзакционно сохраняет сообщение (+ строку медиа, если она есть) и, если сообщение
 * НОВОЕ (saveMessage().inserted === true — не правка и не повторная доставка), пишет строку
 * в domain_events. Outbox-паттерн задачи 9: событие коммитится в ОДНОЙ транзакции с самими
 * данными, поэтому не может потеряться при рестарте api (NOTIFY шлётся вызывающим кодом
 * отдельно, уже после успешного коммита — см. ingest.service.ts).
 */
export async function saveMessageWithEvent(
  db: Kysely<DB>,
  input: IngestMessage,
  media: IngestMediaInput | null,
  event: DomainEventInput,
): Promise<{ id: string; inserted: boolean }> {
  return db.transaction().execute(async (trx) => {
    const result = await saveMessage(trx, input)

    if (media) {
      // Дедуп на пересечении бэкфилла и live-потока (§4/§5 research) — не плодим повторную
      // строку медиа для уже обработанного (message_id, order_index). Не зависит от
      // result.inserted: правка теоретически тоже может донести новое медиа.
      const existing = await trx
        .selectFrom('message_media')
        .select('id')
        .where('message_id', '=', result.id)
        .where('order_index', '=', media.orderIndex)
        .executeTakeFirst()
      if (!existing) {
        await trx
          .insertInto('message_media')
          .values({
            id: media.id,
            message_id: result.id,
            tg_message_id: media.tgMessageId,
            grouped_id: media.groupedId,
            order_index: media.orderIndex,
            storage_path: media.storagePath,
            media_type: media.mediaType,
            width: null,
            height: null,
            bytes: media.bytes,
            sha256: media.sha256,
            created_at: new Date(),
          })
          .execute()
      }
    }

    if (result.inserted) {
      await trx
        .insertInto('domain_events')
        .values({
          type: event.type,
          aggregate: event.aggregate,
          aggregate_id: result.id,
          payload: JSON.stringify(event.payload),
        })
        .execute()
    }

    return result
  })
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
