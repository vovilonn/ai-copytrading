// Сборка контекста для extract_signal (research/ai-layer.md §4.4/§9/§10, задача 2 Ф2):
// компактный снимок открытых позиций канала, текст reply-родителя, картинки сообщения (base64) —
// ровно те три входа, которые buildUserTurn (prompt.ts) кладёт в user-turn, плюс их хэш для
// ключа кэша (cache.ts::cacheKey — openPositionsHash).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Decimal } from 'decimal.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import { serializeOpenPosition, type OpenPositionSummary, type PromptImage } from './prompt.js'

// var/media лежит в корне репозитория (тот же приём, что apps/tg-ingest/src/ingest.service.ts:
// REPO_ROOT), а не в apps/engine — message_media.storage_path хранится ОТНОСИТЕЛЬНО корня
// (напр. 'var/media/ch-1962583820-t173666/221437_0.jpg'), путь считаем от расположения ЭТОГО
// модуля, устойчиво к тому, из какого cwd запущен процесс.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// Minor #3 адверсариального ревью (p2-final-fix-report.md): контейнмент того же поля
// message_media.storage_path, что и apps/api/src/channels/media.controller.ts:12-13/28-29 —
// зеркально тому же приёму (тот же REPO_ROOT-relative формат пути), чтобы кривой/злонамеренный
// storage_path не читал произвольный файл с диска и не сливал его в тело запроса к ai-proxy.
const MEDIA_ROOT = path.join(REPO_ROOT, 'var', 'media')

/** Минимум полей сообщения, нужных buildContext — не весь `messages`-ряд (задача не должна
 *  тащить в сигнатуру всю таблицу ради 3 колонок). */
export interface BuildContextMessage {
  /** messages.id (UUID) — ключ message_media.message_id. */
  id: string
  channelId: number
  /** messages.reply_to_msg_id — tg_message_id родителя внутри того же канала, если есть. */
  replyToMsgId: number | null
}

export interface BuiltAiContext {
  openPositions: OpenPositionSummary[]
  replyParentText?: string
  images: PromptImage[]
  /** sha256 компактного снимка openPositions — идёт в cache.ts::cacheKey (research §10:
   *  "hash(open_positions_snapshot)"), т.к. символ дельты может зависеть от текущих позиций. */
  openPositionsHash: string
}

const OPEN_TP_STATUSES = ['created', 'pending_submit', 'submitted'] as const

/**
 * Собирает контекст сообщения для extract_signal: открытые позиции КАНАЛА (§4.4, компактно —
 * sym/side/legs/avg_entry/sl-состояние/оставшиеся tps), текст reply-родителя (messages по
 * reply_to_msg_id ЭТОГО ЖЕ канала — tg_message_id не глобально уникален), картинки message_media
 * (файл с диска по storage_path, base64).
 */
export async function buildContext(db: Kysely<DB>, message: BuildContextMessage): Promise<BuiltAiContext> {
  const [openPositions, replyParentText, images] = await Promise.all([
    loadOpenPositions(db, message.channelId),
    loadReplyParentText(db, message.channelId, message.replyToMsgId),
    loadImages(db, message.id),
  ])

  const result: BuiltAiContext = { openPositions, images, openPositionsHash: hashOpenPositions(openPositions) }
  if (replyParentText !== undefined) result.replyParentText = replyParentText
  return result
}

/** sha256 канонической сериализации openPositions — ТА ЖЕ форма (serializeOpenPosition из
 *  prompt.ts), что реально уходит в промпт модели (см. комментарий у serializeOpenPosition). */
export function hashOpenPositions(openPositions: readonly OpenPositionSummary[]): string {
  const canonical = JSON.stringify(openPositions.map(serializeOpenPosition))
  return createHash('sha256').update(canonical).digest('hex')
}

// ---------------------------------------------------------------------------
// Открытые позиции канала (§4.4).
// ---------------------------------------------------------------------------

async function loadOpenPositions(db: Kysely<DB>, channelId: number): Promise<OpenPositionSummary[]> {
  const rows = await db
    .selectFrom('positions')
    .select(['symbol', 'side', 'trade_id', 'avg_price', 'stop_loss'])
    .where('channel_id', '=', channelId)
    // Сравнение NUMERIC-колонки через sql-фрагмент (тот же приём, что buildParseContext
    // в pipeline.ts) — билдерное `.where('size', '!=', '0')` сравнивало бы с текстовым
    // литералом без гарантированного приведения типа.
    .where(sql<boolean>`size <> 0`)
    .orderBy('symbol')
    .execute()

  const summaries: OpenPositionSummary[] = []
  for (const row of rows) {
    // side/avg_price не должны быть null при size<>0 (placeEntry всегда пишет их вместе) —
    // но защитно пропускаем противоречивую строку, а не падаем на всём снимке позиций.
    if (row.side === null || row.avg_price === null) continue
    const side = row.side
    const avgPrice = row.avg_price

    const legs = row.trade_id !== null ? await countAddLegs(db, row.trade_id) : 0
    const tpsLeft = row.trade_id !== null ? await loadTpsLeft(db, row.trade_id) : []
    const opened = row.trade_id !== null ? await loadOpenedTgMessageId(db, row.trade_id) : undefined

    summaries.push({
      sym: row.symbol,
      side,
      legs,
      avgEntry: new Decimal(avgPrice).toNumber(),
      sl: resolveSlState(row.stop_loss, avgPrice),
      tpsLeft,
      ...(opened !== undefined ? { opened } : {}),
    })
  }
  return summaries
}

/** 'BE' — стоп на средней цене входа (безубыток); число — конкретная цена; 'none' — стопа нет. */
function resolveSlState(stopLoss: string | null, avgPrice: string): 'BE' | number | 'none' {
  if (stopLoss === null) return 'none'
  if (new Decimal(stopLoss).equals(new Decimal(avgPrice))) return 'BE'
  return new Decimal(stopLoss).toNumber()
}

/** «Число доборов» (research/channel-adapters.md §4.4: "число доборов", не общее число лег) —
 *  только kind='add', исходная entry-лега не считается добором. */
async function countAddLegs(db: Kysely<DB>, tradeId: string): Promise<number> {
  const row = await db
    .selectFrom('trade_legs')
    .select(({ fn }) => fn.countAll<string>().as('n'))
    .where('trade_id', '=', tradeId)
    .where('kind', '=', 'add')
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

/** Оставшиеся (ещё не сработавшие/не отменённые) цели TP-лесенки, по возрастанию tp_index. */
async function loadTpsLeft(db: Kysely<DB>, tradeId: string): Promise<number[]> {
  const rows = await db
    .selectFrom('orders')
    .select('price')
    .where('trade_id', '=', tradeId)
    .where('purpose', '=', 'tp')
    .where('status', 'in', [...OPEN_TP_STATUSES])
    .orderBy('tp_index', 'asc')
    .execute()
  return rows.map((r) => r.price).filter((p): p is string => p !== null).map((p) => new Decimal(p).toNumber())
}

/** tg_message_id сообщения, открывшего сделку (опциональное поле §4.4 "opened") — для трассировки. */
async function loadOpenedTgMessageId(db: Kysely<DB>, tradeId: string): Promise<number | undefined> {
  const row = await db
    .selectFrom('trades')
    .innerJoin('messages', 'messages.id', 'trades.opened_msg_id')
    .select('messages.tg_message_id')
    .where('trades.id', '=', tradeId)
    .executeTakeFirst()
  return row?.tg_message_id
}

// ---------------------------------------------------------------------------
// Текст reply-родителя.
// ---------------------------------------------------------------------------

async function loadReplyParentText(
  db: Kysely<DB>,
  channelId: number,
  replyToMsgId: number | null,
): Promise<string | undefined> {
  if (replyToMsgId === null) return undefined
  // tg_message_id уникален ТОЛЬКО в паре с channel_id (messages: UNIQUE(channel_id, tg_message_id)) —
  // без фильтра по каналу можно было бы найти чужое сообщение с тем же numeric id.
  const row = await db
    .selectFrom('messages')
    .select('text')
    .where('channel_id', '=', channelId)
    .where('tg_message_id', '=', replyToMsgId)
    .executeTakeFirst()
  return row?.text
}

// ---------------------------------------------------------------------------
// Картинки сообщения (base64).
// ---------------------------------------------------------------------------

async function loadImages(db: Kysely<DB>, messageId: string): Promise<PromptImage[]> {
  const rows = await db
    .selectFrom('message_media')
    .select(['storage_path', 'media_type'])
    .where('message_id', '=', messageId)
    .orderBy('order_index', 'asc')
    .execute()

  const images: PromptImage[] = []
  for (const row of rows) {
    // Minor #3 адверсариального ревью: контейнмент — тот же приём, что media.controller.ts
    // (28-29): абсолютные пути и выход через ".." отклоняются одинаково, единственный путь
    // наружу закрыт. storage_path пишет только воркер (tg-ingest), но отдавать содержимое файла
    // модели без проверки нельзя: одна кривая миграция/ручной UPDATE — и loadImages прочитает
    // /etc/passwd и отправит его в ai-proxy как "картинку".
    const relative = row.storage_path.replace(/^var[/\\]media[/\\]/, '')
    const absolutePath = path.resolve(MEDIA_ROOT, relative)
    if (absolutePath !== MEDIA_ROOT && !absolutePath.startsWith(MEDIA_ROOT + path.sep)) {
      console.warn(`[ai/context] storage_path вне var/media (контейнмент), картинка пропущена: ${row.storage_path}`)
      continue
    }
    try {
      const buffer = await fs.readFile(absolutePath)
      images.push({ base64: buffer.toString('base64'), mediaType: row.media_type })
    } catch (err) {
      // Файл мог не докачаться/быть удалён (media-repair.ts — отдельный ремонтный проход) —
      // разбор не должен падать целиком из-за одной недостающей картинки, просто без неё.
      console.warn(`[ai/context] не удалось прочитать медиа ${absolutePath}: ${(err as Error).message}`)
    }
  }
  return images
}
