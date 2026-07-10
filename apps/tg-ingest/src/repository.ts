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
 * Вставляет строку message_media, если такой (message_id, order_index) ещё нет —
 * дедуп на пересечении бэкфилла/live-потока/ремонтного прохода (§4/§5 research, задача 12b).
 * Опирается на UNIQUE(message_id, order_index) из 002_media_repair.ts: гонка исключена на
 * уровне БД, а не только приложения (в отличие от прежнего select-затем-insert).
 * Возвращает true, если строка реально вставлена этим вызовом (а не пропущена как дубль).
 */
export async function insertMediaRow(
  db: Kysely<DB>,
  messageId: string,
  media: IngestMediaInput,
): Promise<boolean> {
  const result = await db
    .insertInto('message_media')
    .values({
      id: media.id,
      message_id: messageId,
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
    .onConflict((oc) => oc.columns(['message_id', 'order_index']).doNothing())
    .executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0
}

export interface MediaRepairCandidate {
  messageDbId: string
  channelId: number
  tgMessageId: number
  groupedId: string | null
}

/**
 * Кандидаты ремонтного прохода (задача 12b): has_media=true (по честной семантике —
 * pickMedia() на вставке вернул скачиваемый hint, см. ingest.service.ts persistMessage),
 * но строки message_media нет, и предыдущие попытки ремонта ещё не исчерпаны.
 */
export async function findMediaRepairCandidates(
  db: Kysely<DB>,
  limit: number,
): Promise<MediaRepairCandidate[]> {
  const rows = await db
    .selectFrom('messages as m')
    .select([
      'm.id as messageDbId',
      'm.channel_id as channelId',
      'm.tg_message_id as tgMessageId',
      'm.grouped_id as groupedId',
    ])
    .where('m.has_media', '=', true)
    .where('m.media_repair_failed_at', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('message_media as mm').select('mm.id').whereRef('mm.message_id', '=', 'm.id'),
        ),
      ),
    )
    .orderBy('m.received_at', 'asc')
    .limit(limit)
    .execute()
  return rows
}

/**
 * order_index у альбома — позиция сообщения среди всех его "братьев" (тот же grouped_id),
 * отсортированных по возрастанию tg_message_id (album-buffer.ts release() сортирует так же
 * перед вызовом handleAlbum — см. task-12b-report.md). Считается по ВСЕМ сообщениям группы
 * (не только по ремонтируемым), иначе позиция разойдётся с уже вставленными строками.
 */
export async function computeAlbumOrderIndex(
  db: Kysely<DB>,
  channelId: number,
  groupedIds: readonly string[],
): Promise<Map<string, Map<number, number>>> {
  const result = new Map<string, Map<number, number>>()
  if (groupedIds.length === 0) return result

  const { rows } = await sql<{ grouped_id: string; tg_message_id: number; order_index: number }>`
    SELECT grouped_id, tg_message_id,
           (row_number() OVER (PARTITION BY grouped_id ORDER BY tg_message_id) - 1)::int AS order_index
    FROM messages
    WHERE channel_id = ${channelId} AND grouped_id = ANY(${groupedIds})
  `.execute(db)

  for (const row of rows) {
    const perGroup = result.get(row.grouped_id) ?? new Map<number, number>()
    perGroup.set(row.tg_message_id, row.order_index)
    result.set(row.grouped_id, perGroup)
  }
  return result
}

/**
 * Фиксирует неудачную попытку ремонта: инкрементирует счётчик и, только исчерпав maxAttempts,
 * проставляет media_repair_failed_at — навсегда исключая сообщение из будущих сканирований
 * (удалено в Telegram / медиа объективно недоступно). Разовая сетевая флуктуация не должна
 * закрывать ремонт после первой же неудачи — отсюда порог, а не немедленная пометка.
 */
export async function recordMediaRepairAttempt(
  db: Kysely<DB>,
  messageDbId: string,
  maxAttempts: number,
): Promise<void> {
  await sql`
    UPDATE messages
    SET media_repair_attempts = media_repair_attempts + 1,
        media_repair_failed_at = CASE
          WHEN media_repair_attempts + 1 >= ${maxAttempts} THEN now()
          ELSE media_repair_failed_at
        END
    WHERE id = ${messageDbId}
  `.execute(db)
}

export interface AlbumMemberInput extends IngestMessage {
  media: IngestMediaInput | null
}

/**
 * Транзакционно сохраняет ВСЕ сообщения альбома (+ их строки медиа) и, если хотя бы одно
 * из них оказалось НОВЫМ (saveMessage().inserted === true хотя бы у одного члена), пишет
 * РОВНО ОДНУ строку в domain_events — на весь альбом, а не по одной на сообщение (задача 12c:
 * Telegram доставляет альбом N отдельными сообщениями с общим grouped_id, а таймлайн обязан
 * рисовать его одним узлом, поэтому и событие 'message.new' должно уйти один раз).
 * `members` обязаны быть отсортированы по возрастанию tgMessageId (album-buffer.ts release()
 * уже так сортирует) — первый элемент становится якорем события (aggregate_id), его id идёт
 * в payload, который строит `buildEvent`. Одиночное сообщение — вырожденный случай альбома
 * из одного элемента, тот же код путь.
 * Тот же outbox-паттерн задачи 9, что и у saveMessageWithEvent ниже: событие коммитится в
 * ОДНОЙ транзакции с данными всех сообщений альбома — либо весь альбом целиком (данные +
 * событие) закоммичен, либо ничего (NOTIFY шлётся вызывающим кодом отдельно, после коммита).
 */
export async function saveAlbumWithEvent(
  db: Kysely<DB>,
  members: readonly AlbumMemberInput[],
  buildEvent: (anchorMessageId: string) => DomainEventInput,
): Promise<{ anchorId: string; anyInserted: boolean }> {
  if (members.length === 0) throw new Error('saveAlbumWithEvent: пустой альбом')

  return db.transaction().execute(async (trx) => {
    const results: { id: string; inserted: boolean }[] = []
    for (const member of members) {
      const saved = await saveMessage(trx, member)
      if (member.media) await insertMediaRow(trx, saved.id, member.media)
      results.push(saved)
    }

    const anchor = results[0]! // members гарантированно непусты (проверка выше)
    const anyInserted = results.some((r) => r.inserted)

    if (anyInserted) {
      const event = buildEvent(anchor.id)
      await trx
        .insertInto('domain_events')
        .values({
          type: event.type,
          aggregate: event.aggregate,
          aggregate_id: anchor.id,
          payload: JSON.stringify(event.payload),
        })
        .execute()
    }

    return { anchorId: anchor.id, anyInserted }
  })
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
      await insertMediaRow(trx, result.id, media)
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
