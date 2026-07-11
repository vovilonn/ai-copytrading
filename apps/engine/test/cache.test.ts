import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { ExtractSignalOutput } from '../src/ai/schema.js'
import { cacheKey, getCached, putCached, type AiCacheSchema } from '../src/ai/cache.js'

// cache.ts (задача 2 Ф2, research/ai-layer.md §10): чистый cacheKey (без БД) + round-trip
// getCached/putCached против реальной copytrade_test (ai_cache — самостоятельная таблица, без
// FK на messages/channels — миграция 001_initial.ts).

describe('cacheKey', () => {
  const base = {
    model: 'claude-sonnet-4-5-20250929',
    normalizedText: 'стоп на твх',
    mediaIds: ['a', 'b'],
    replyParentId: 221419,
    openPositionsHash: 'hash-1',
    promptVersion: 'extract_signal.v1',
  }

  it('одинаковый вход -> тот же ключ', () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }))
  })

  it('разный openPositionsHash -> разный ключ (символ дельты зависит от позиций)', () => {
    const other = cacheKey({ ...base, openPositionsHash: 'hash-2' })
    expect(other).not.toBe(cacheKey(base))
  })

  it('порядок mediaIds не влияет (сортируются внутри)', () => {
    const shuffled = cacheKey({ ...base, mediaIds: ['b', 'a'] })
    expect(shuffled).toBe(cacheKey(base))
  })

  it('разная модель -> разный ключ', () => {
    expect(cacheKey({ ...base, model: 'claude-opus-4-8' })).not.toBe(cacheKey(base))
  })

  it('разный normalizedText -> разный ключ', () => {
    expect(cacheKey({ ...base, normalizedText: 'другой текст' })).not.toBe(cacheKey(base))
  })

  it('разный replyParentId (в т.ч. null) -> разный ключ', () => {
    const noReply = cacheKey({ ...base, replyParentId: null })
    expect(noReply).not.toBe(cacheKey(base))
    expect(noReply).not.toBe(cacheKey({ ...base, replyParentId: 999 }))
  })

  it('результат — hex sha256 (64 символа)', () => {
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('getCached / putCached (round-trip, copytrade_test)', () => {
  let db: Kysely<AiCacheSchema>

  beforeAll(async () => {
    // createDb(...) возвращает Kysely<DB> (api/db/database.ts), а DB не типизирует ai_cache
    // (комментарий в database.ts: "объявляются по мере использования") — приводим к узкой
    // AiCacheSchema (та же причина, что у AiCallsSchema в client.ts). Каст безопасен: Kysely<T>
    // не более чем типовая проекция поверх ОДНОГО и того же реального pg.Pool/соединения.
    db = createDb(process.env.DATABASE_URL!) as unknown as Kysely<AiCacheSchema>
    await migrateToLatest(db)
    await resetTestSchema(db)
  })

  afterAll(async () => {
    await db.destroy()
  })

  const sampleOutput: ExtractSignalOutput = {
    understood: true,
    needs_human: false,
    message_type: 'entry',
    image_used: false,
    confidence: 0.95,
    summary: 'SOL long limit 79.3',
    actions: [{ type: 'open', symbol: 'SOLUSDT', side: 'long', order_type: 'limit', evidence_source: 'text' }],
  }

  it('getCached на новый ключ -> null (кэш-промах)', async () => {
    const key = cacheKey({
      model: 'claude-sonnet-4-5-20250929',
      normalizedText: 'нет в кэше ' + Math.random(),
      mediaIds: [],
      replyParentId: null,
      openPositionsHash: 'h',
      promptVersion: 'extract_signal.v1',
    })
    expect(await getCached(db, key)).toBeNull()
  })

  it('putCached -> getCached возвращает тот же response', async () => {
    const key = cacheKey({
      model: 'claude-sonnet-4-5-20250929',
      normalizedText: '2🎯',
      mediaIds: ['media-1'],
      replyParentId: null,
      openPositionsHash: 'h-sol',
      promptVersion: 'extract_signal.v1',
    })

    await putCached(db, key, sampleOutput, 'claude-sonnet-4-5-20250929', 'extract_signal.v1')
    const cached = await getCached(db, key)

    expect(cached).toEqual(sampleOutput)
  })

  it('повторный putCached с тем же ключом идемпотентен (не падает, не плодит вторую строку)', async () => {
    const key = cacheKey({
      model: 'claude-sonnet-4-5-20250929',
      normalizedText: 'фикс половину',
      mediaIds: [],
      replyParentId: 221447,
      openPositionsHash: 'h-btc',
      promptVersion: 'extract_signal.v1',
    })

    await putCached(db, key, sampleOutput, 'claude-sonnet-4-5-20250929', 'extract_signal.v1')
    await putCached(db, key, sampleOutput, 'claude-sonnet-4-5-20250929', 'extract_signal.v1')

    const rows = await db.selectFrom('ai_cache').selectAll().where('request_hash', '=', key).execute()
    expect(rows).toHaveLength(1)
  })
})
