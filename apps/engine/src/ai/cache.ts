// Кэш разбора AI (research/ai-layer.md §10, задача 2 Ф2): application-level кэш поверх таблицы
// `ai_cache` (миграция 001_initial.ts) — экономит повторный вызов extract_signal на identical
// вход (тот же текст/картинки/reply/открытые позиции/модель/версия промпта). Отдельно от
// Anthropic prompt-caching (client.ts) — тот кэширует ПРЕФИКС запроса на стороне модели за
// TTL 5 минут, этот кэширует ПОЛНЫЙ ОТВЕТ на неограниченный срок по детерминированному ключу.

import { createHash } from 'node:crypto'
import type { Generated, Kysely } from 'kysely'
import type { ExtractSignalOutput } from './schema.js'

/**
 * Компоненты ключа кэша (research §10, дословно): `sha256(model + normalized_text +
 * sorted(media_ids) + reply_parent_id + hash(open_positions_snapshot) + prompt_version)`.
 * Открытые позиции ВХОДЯТ в ключ — символ символьной дельты («Стоп на твх») зависит от них,
 * поэтому один и тот же текст с разным состоянием позиций обязан парситься заново.
 */
export interface CacheKeyParams {
  model: string
  normalizedText: string
  /** Идентификаторы вложенных медиа (напр. message_media.id или sha256 файла) — порядок не
   *  важен, cacheKey сортирует сам (research §10: "sorted(media_ids)"). */
  mediaIds: readonly string[]
  /** tg_message_id родителя по reply, если есть; null — сообщение не является ответом. */
  replyParentId: number | null
  /**
   * Символ ветки, вычисленный движком (context.ts::resolveChainSymbol), — он ЕДЕТ В ПРОМПТ
   * ([reply_thread_symbol]) и потому обязан быть в ключе. Из replyParentId он не следует: движок
   * берёт его в том числе из УЖЕ РАЗОБРАННЫХ действий предков, а те появляются позже самого
   * родителя. Без этого поля перезапуск сообщения после того, как ветка стала понятна, честно
   * доставал бы из кэша прежний ответ с symbol=UNKNOWN.
   */
  replyChainSymbol: string | null
  /** sha256-хэш компактного снимка открытых позиций (см. context.ts::hashOpenPositions) —
   *  уже посчитанный хэш, а не сырой снимок (снимок собирается один раз в buildContext). */
  openPositionsHash: string
  promptVersion: string
}

const FIELD_SEP = ' ' // не встречается в обычном тексте/id — исключает склейку полей на границе

/** Детерминированный ключ разбора (research §10). Одинаковый вход → тот же ключ; порядок
 *  mediaIds не влияет (сортируются здесь); разный openPositionsHash → разный ключ. */
export function cacheKey(params: CacheKeyParams): string {
  const sortedMediaIds = [...params.mediaIds].sort()
  const canonical = [
    params.model,
    params.normalizedText,
    JSON.stringify(sortedMediaIds),
    params.replyParentId === null ? '' : String(params.replyParentId),
    params.replyChainSymbol ?? '',
    params.openPositionsHash,
    params.promptVersion,
  ].join(FIELD_SEP)
  return createHash('sha256').update(canonical).digest('hex')
}

/** Kysely-схема только для `ai_cache` (см. комментарий у AiCallsSchema в client.ts — та же
 *  причина: apps/api/src/db/database.ts не типизирует эту таблицу, "объявляются по мере
 *  использования"). response — JSONB, храним/читаем как ExtractSignalOutput. */
export interface AiCacheSchema {
  ai_cache: {
    request_hash: string
    model: string
    prompt_version: string
    response: unknown
    // DEFAULT now() в миграции (001_initial.ts) — Generated<>, как остальные DEFAULT-колонки
    // в api/db/database.ts (messages.received_at и т.п.), иначе insertInto(...).values() требовал
    // бы передавать created_at вручную на каждой записи.
    created_at: Generated<Date>
  }
}

/** Читает закэшированный разбор по ключу. null — кэш-промах (ключ не встречался раньше). */
export async function getCached(db: Kysely<AiCacheSchema>, key: string): Promise<ExtractSignalOutput | null> {
  const row = await db.selectFrom('ai_cache').select('response').where('request_hash', '=', key).executeTakeFirst()
  // node-postgres сам парсит JSONB в JS-объект (не строку) — доп. JSON.parse не нужен.
  return row ? (row.response as ExtractSignalOutput) : null
}

/**
 * Пишет разбор в кэш. Идемпотентно: `ON CONFLICT ... DO NOTHING` (тот же приём, что addLeg/
 * acquireSymbol/DryRunAdapter — state/trades.ts, execution/dry-run.adapter.ts) — повторная
 * запись по уже существующему ключу не перезаписывает первый закэшированный ответ (ключ
 * детерминирован входом, "первый выигравший" разбор и есть канонический для этого входа).
 */
export async function putCached(
  db: Kysely<AiCacheSchema>,
  key: string,
  output: ExtractSignalOutput,
  model: string,
  promptVersion: string,
): Promise<void> {
  await db
    .insertInto('ai_cache')
    .values({
      request_hash: key,
      model,
      prompt_version: promptVersion,
      response: JSON.stringify(output),
    })
    .onConflict((oc) => oc.column('request_hash').doNothing())
    .execute()
}
