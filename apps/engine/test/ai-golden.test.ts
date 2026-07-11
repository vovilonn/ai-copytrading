// Golden set форума (задача 5 Ф2, research/ai-layer.md §7, docs/superpowers/research/
// channel-adapters.md §7 E1-E6): 30 самых сложных ДЕЙСТВЕННЫХ сообщений 2-го канала (терсные
// с картинкой, мульти-символ, modify_sl-маркеры), размеченных ГЛАЗАМИ (текст+картинка) в
// apps/engine/test/fixtures/ch2-golden.json. Прогоняет каждое через ЖИВОЙ ai-proxy
// (callExtractSignal -> normalizeAiOutput — тот же путь, что и реальный AI-пайплайн, задача 2/4
// Ф2), сравнивает извлечённые (symbol, type) с эталоном, печатает precision/recall.
//
// Порог (задача, "терять действия — худший исход"): recall >= 0.85 (жёстко), precision >= 0.75
// (мягче — фолзы терпимее пропусков). Skip целиком, если не задан AI_LIVE_TESTS=1 (Important #2
// финального ревью Ф2, p2-final-fix-report.md) ИЛИ ai-proxy недоступен (тот же приём, что
// ai-client.test.ts/pipeline-ai.e2e.test.ts).
//
// Кэш (ai/cache.ts, ai_cache) ускоряет ПОВТОРНЫЕ прогоны ЭТОГО файла (напр. при калибровке
// промпта: `pnpm --filter engine exec vitest run test/ai-golden.test.ts` несколько раз подряд) —
// НЕ вызываем resetTestSchema для ai_cache, иначе кэш обнулялся бы на каждом прогоне и терял
// смысл. Полный `pnpm --filter engine test` всё равно рано или поздно труנкейтит ai_cache через
// beforeEach других файлов (pipeline-ai.e2e.test.ts и т.п.) — это не портит корректность, только
// не даёт межпрогонного ускорения при запуске ВСЕГО сьюта, что приемлемо (сама метрика от кэша
// не зависит, кэш — только про скорость).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Kysely } from 'kysely'
import { createDb } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { ParsedIntent, ParsedResult } from 'shared/domain.js'
import { callExtractSignal, PROMPT_VERSION, MODEL_SONNET } from '../src/ai/client.js'
import { normalizeAiOutput } from '../src/ai/normalize-output.js'
import { cacheKey, getCached, putCached, type AiCacheSchema } from '../src/ai/cache.js'
import { hashOpenPositions } from '../src/ai/context.js'
import type { OpenPositionSummary, PromptImage } from '../src/ai/prompt.js'

const AI_PROXY_URL = process.env.AI_PROXY_URL ?? 'http://127.0.0.1:8317'
const DUMP_DIR = fileURLToPath(new URL('../../../temp/tg-dump/ch-1962583820-t173666/', import.meta.url))
const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/ch2-golden.json', import.meta.url))

// Important #2 адверсариального ревью (p2-final-fix-report.md): этот файл прогоняет ДО 30
// golden-кейсов через живой ai-proxy на каждый прогон — гейтить ТОЛЬКО на "прокси доступен"
// (локальный ai-proxy почти всегда поднят) означало бы, что обычный `pnpm test` молча жжёт
// платную подписку. Явный opt-in: AI_LIVE_TESTS=1. Без флага — describe.skip с понятным сообщением.
const AI_LIVE_TESTS = process.env.AI_LIVE_TESTS === '1'
if (!AI_LIVE_TESTS) {
  console.warn('[ai-golden.test] живые AI-тесты пропущены; задайте AI_LIVE_TESTS=1 для запуска (жжёт платный ai-proxy, до 30 вызовов)')
}
const describeLive = AI_LIVE_TESTS ? describe : describe.skip

// ---------------------------------------------------------------------------
// Golden fixture + сырой дамп (для reply-parent текста — та же роль, что messages в БД у
// buildContext, но здесь читаем НАПРЯМУЮ из дампа, без сидинга БД: задача просит "собрать
// контекст (картинка из dump, openPositions можешь дать пустыми/синтетическими)").
// ---------------------------------------------------------------------------

interface GoldenAction {
  symbol: string
  type: string
  side: string
}

interface GoldenCase {
  id: number
  text: string
  mediaFile?: string
  /** Синтетические открытые позиции под конкретный кейс (research §4.4/§4.2) — только там,
   *  где символ символ-less дельты резолвится ИСКЛЮЧИТЕЛЬНО через них (221386/221420). */
  openPositions?: OpenPositionSummary[]
  note?: string
  expected: GoldenAction[]
}

interface DumpMessage {
  id: number
  date: string
  text: string | null
  media: string | null
  mediaFile: string | null
  groupedId: number | null
  replyToMsgId: number | null
}

function loadGolden(): GoldenCase[] {
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenCase[]
}

function loadDump(): Map<number, DumpMessage> {
  const lines = readFileSync(`${DUMP_DIR}messages.jsonl`, 'utf8').trim().split('\n')
  const map = new Map<number, DumpMessage>()
  for (const line of lines) {
    const msg = JSON.parse(line) as DumpMessage
    map.set(msg.id, msg)
  }
  return map
}

/** Читает картинку golden-кейса с диска дампа (Ф2 §9: весь дамп — .jpg) и base64-кодирует. */
function loadImage(mediaFile: string): PromptImage {
  const buffer = readFileSync(`${DUMP_DIR}media/${mediaFile}`)
  return { base64: buffer.toString('base64'), mediaType: 'image/jpeg' }
}

async function proxyAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${AI_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL_SONNET, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    return res.status > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// normalizeAiOutput -> плоский список (symbol, type) для сверки с golden.expected (см. схему
// extract_signal.actions[].type/normalize-output.ts DeltaOp.op — тот же словарь типов, что и
// задача просит в golden: open/add/close/modify_sl/modify_tp/cancel_order/tp_hit/sl_hit).
// ---------------------------------------------------------------------------

function opToType(op: string): string {
  switch (op) {
    case 'sl_set':
    case 'sl_breakeven':
    case 'sl_cancel':
      return 'modify_sl'
    case 'tp_set':
      return 'modify_tp'
    case 'tp_hit':
      return 'tp_hit'
    case 'sl_hit':
      return 'sl_hit'
    case 'cancel_pending':
      return 'cancel_order'
    case 'partial_close':
    case 'close_remainder':
      return 'close'
    default:
      return op // 'hold' и прочее — не встречается в golden, попадёт в FP если появится
  }
}

function flatten(result: ParsedResult): Array<{ symbol: string | null; type: string }> {
  const out: Array<{ symbol: string | null; type: string }> = []
  for (const intent of result.intents as ParsedIntent[]) {
    switch (intent.kind) {
      case 'entry_signal':
      case 'limit_entry':
      case 'market_entry':
        out.push({ symbol: intent.symbol, type: 'open' })
        break
      case 'add':
        out.push({ symbol: intent.symbol, type: 'add' })
        break
      case 'delta':
        for (const op of intent.ops) out.push({ symbol: intent.symbol, type: opToType(op.op) })
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Мультимножественное сравнение (symbol,type): matched = min(expected_count, extracted_count)
// на каждый ключ — устойчиво к дублям внутри одного сообщения (в golden их нет, но на выходе
// модели теоретически возможны).
// ---------------------------------------------------------------------------

function tupleKey(symbol: string | null, type: string): string {
  return `${symbol ?? 'UNKNOWN'}|${type}`
}

function countBy<T>(items: T[], toKey: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = toKey(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

interface CaseGrading {
  id: number
  tp: number
  fp: number
  fn: number
  missing: string[] // ключи, ожидавшиеся, но не извлечённые
  extra: string[] // ключи, извлечённые, но не ожидавшиеся
}

function gradeCase(id: number, expected: GoldenAction[], extracted: Array<{ symbol: string | null; type: string }>): CaseGrading {
  const expectedCounts = countBy(expected, (e) => tupleKey(e.symbol, e.type))
  const extractedCounts = countBy(extracted, (e) => tupleKey(e.symbol, e.type))

  let tp = 0
  const missing: string[] = []
  const extra: string[] = []

  const allKeys = new Set([...expectedCounts.keys(), ...extractedCounts.keys()])
  for (const key of allKeys) {
    const expCount = expectedCounts.get(key) ?? 0
    const extCount = extractedCounts.get(key) ?? 0
    const matched = Math.min(expCount, extCount)
    tp += matched
    if (expCount > matched) missing.push(`${key} (x${expCount - matched})`)
    if (extCount > matched) extra.push(`${key} (x${extCount - matched})`)
  }

  const fn = expected.length - tp
  const fp = extracted.length - tp
  return { id, tp, fp, fn, missing, extra }
}

// ---------------------------------------------------------------------------

describeLive('golden set CH2 — precision/recall извлечения actions (живой ai-proxy) — требует AI_LIVE_TESTS=1', () => {
  let available = false
  let db: Kysely<AiCacheSchema>

  beforeAll(async () => {
    available = await proxyAvailable()
    if (!available) {
      console.warn('[ai-golden] ai-proxy недоступен — golden-тест пропущен')
      return
    }
    db = createDb(process.env.DATABASE_URL!) as unknown as Kysely<AiCacheSchema>
    await migrateToLatest(db)
  })

  afterAll(async () => {
    if (available) await db.destroy()
  })

  it(
    '30 golden-сообщений CH2 -> recall >= 0.85, precision >= 0.75 (репорт)',
    async () => {
      if (!available) return // явный skip, тот же приём, что и остальные live-тесты AI-слоя

      const golden = loadGolden()
      const dump = loadDump()
      expect(golden).toHaveLength(30)

      const gradings: CaseGrading[] = []

      for (const goldenCase of golden) {
        const dumpMsg = dump.get(goldenCase.id)
        if (!dumpMsg) throw new Error(`golden id=${goldenCase.id} отсутствует в дампе messages.jsonl`)

        const parent = dumpMsg.replyToMsgId !== null ? dump.get(dumpMsg.replyToMsgId) : undefined
        const replyParentText = parent?.text ?? undefined
        const replyParentId = parent ? dumpMsg.replyToMsgId : null

        const images: PromptImage[] = goldenCase.mediaFile ? [loadImage(goldenCase.mediaFile)] : []
        const openPositions: OpenPositionSummary[] = goldenCase.openPositions ?? []

        const key = cacheKey({
          model: MODEL_SONNET,
          normalizedText: goldenCase.text,
          mediaIds: goldenCase.mediaFile ? [goldenCase.mediaFile] : [],
          replyParentId,
          openPositionsHash: hashOpenPositions(openPositions),
          promptVersion: PROMPT_VERSION,
        })

        let output = await getCached(db, key)
        if (!output) {
          try {
            const result = await callExtractSignal({
              text: goldenCase.text,
              tMsg: dumpMsg.date,
              ...(replyParentText !== undefined ? { replyParentText } : {}),
              openPositions,
              images,
            })
            output = result.output
            await putCached(db, key, output, MODEL_SONNET, PROMPT_VERSION)
          } catch (err) {
            // Единичный сбой вызова не должен ронять весь прогон 30 сообщений — считаем его
            // "0 извлечённых actions" (худший случай для recall, честно засчитывается как FN).
            console.warn(`[ai-golden] callExtractSignal упал на id=${goldenCase.id}: ${(err as Error).message}`)
            output = { understood: false, needs_human: true, message_type: 'noise', image_used: false, confidence: 0, summary: '', actions: [] }
          }
        }

        const parsed = normalizeAiOutput(output)
        const extracted = flatten(parsed)
        const grading = gradeCase(goldenCase.id, goldenCase.expected, extracted)
        gradings.push(grading)

        if (grading.missing.length > 0 || grading.extra.length > 0) {
          console.log(
            `[ai-golden] id=${goldenCase.id} text=%o missing=%o extra=%o`,
            goldenCase.text.slice(0, 60),
            grading.missing,
            grading.extra,
          )
        }
      }

      const totalTp = gradings.reduce((s, g) => s + g.tp, 0)
      const totalFp = gradings.reduce((s, g) => s + g.fp, 0)
      const totalFn = gradings.reduce((s, g) => s + g.fn, 0)
      const precision = totalTp / (totalTp + totalFp || 1)
      const recall = totalTp / (totalTp + totalFn || 1)

      console.log(
        `[ai-golden] ИТОГ: TP=${totalTp} FP=${totalFp} FN=${totalFn} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
      )
      const allMissing = gradings.filter((g) => g.missing.length > 0)
      if (allMissing.length > 0) {
        console.log(
          '[ai-golden] ПОТЕРЯННЫЕ actions (recall):',
          allMissing.map((g) => `#${g.id}: ${g.missing.join(', ')}`).join(' | '),
        )
      }
      const allExtra = gradings.filter((g) => g.extra.length > 0)
      if (allExtra.length > 0) {
        console.log(
          '[ai-golden] ЛИШНИЕ actions (precision):',
          allExtra.map((g) => `#${g.id}: ${g.extra.join(', ')}`).join(' | '),
        )
      }

      // Порог задачи: recall — жёсткий (терять действия хуже всего), precision — мягче.
      expect(recall, `recall ${recall.toFixed(3)} < 0.85 (потери: ${JSON.stringify(allMissing)})`).toBeGreaterThanOrEqual(0.85)
      expect(precision, `precision ${precision.toFixed(3)} < 0.75 (лишнее: ${JSON.stringify(allExtra)})`).toBeGreaterThanOrEqual(0.75)
    },
    600_000, // 30 сообщений x ~6-13с (research §7 p50/p95 Sonnet) первый (некэшированный) прогон
  )
})
