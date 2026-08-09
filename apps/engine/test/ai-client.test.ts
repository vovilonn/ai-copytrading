import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXTRACT_SIGNAL_TOOL } from '../src/ai/schema.js'
import { buildUserTurn, EXTRACTOR_INSTRUCTION } from '../src/ai/prompt.js'
import { callExtractSignal } from '../src/ai/client.js'

// Тесты AI-клиента (задача 1, Ф2; гейт живых тестов — Important #2 финального ревью Ф2,
// p2-final-fix-report.md). Четыре группы:
//  1) ЖИВОЙ тест против ai-proxy — гейт AI_LIVE_TESTS=1 (явный opt-in, см. ниже) И доступность
//     прокси (healthz-пинг); таймаут 60с.
//  2) ЧИСТЫЙ тест сборки промпта buildUserTurn (без сети/БД).
//  3) ЧИСТЫЙ тест схемы extract_signal.
//  4) ЧИСТЫЙ тест таймаута зависшего fetch (Important #1) — мок fetch, без сети/БД.

const AI_PROXY_URL = process.env.AI_PROXY_URL ?? 'http://127.0.0.1:8317'
// Карточка WEEX SOLUSDT (research: терсное '2🎯', символ только на картинке).
const SOL_CARD_PATH = fileURLToPath(new URL('../../../temp/tg-dump/ch-1962583820-t173666/media/221437.jpg', import.meta.url))

// Important #2 адверсариального ревью: локальный ai-proxy почти всегда поднят (docker compose) —
// гейтить живые AI-тесты ТОЛЬКО на "прокси доступен" означает, что обычный `pnpm test` молча жжёт
// платный ai-proxy на каждом прогоне. Явный opt-in: AI_LIVE_TESTS=1. Без флага — describe.skip с
// понятным сообщением, доступность прокси проверяется ТОЛЬКО когда флаг уже включён.
const AI_LIVE_TESTS = process.env.AI_LIVE_TESTS === '1'
if (!AI_LIVE_TESTS) {
  console.warn('[ai-client.test] живые AI-тесты пропущены; задайте AI_LIVE_TESTS=1 для запуска (жжёт платный ai-proxy)')
}
const describeLive = AI_LIVE_TESTS ? describe : describe.skip

/** Пробует достучаться до прокси (короткий таймаут). true — доступен, живой тест выполняется. */
async function proxyAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${AI_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    // Любой HTTP-ответ (даже 4xx) означает, что прокси поднят и слушает.
    return res.status > 0
  } catch {
    return false
  }
}

describe('EXTRACT_SIGNAL_TOOL (схема)', () => {
  it('name === extract_signal', () => {
    expect(EXTRACT_SIGNAL_TOOL.name).toBe('extract_signal')
  })

  it('input_schema.required содержит все верхнеуровневые поля вывода', () => {
    const required = EXTRACT_SIGNAL_TOOL.input_schema.required
    for (const field of ['understood', 'needs_human', 'message_type', 'image_used', 'confidence', 'summary', 'actions']) {
      expect(required).toContain(field)
    }
  })

  it('actions[].required — type/symbol/side/evidence_source', () => {
    const actionRequired = EXTRACT_SIGNAL_TOOL.input_schema.properties.actions.items.required
    expect(actionRequired).toEqual(['type', 'symbol', 'side', 'evidence_source'])
  })
})

describe('buildUserTurn (сборка промпта)', () => {
  const oneByOnePngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('первый блок — инструкция с cache_control:{type:ephemeral}', () => {
    const blocks = buildUserTurn({ text: '2🎯', tMsg: '2026-06-24T20:13:11.000Z', openPositions: [], images: [] })
    const first = blocks[0]!
    expect(first.type).toBe('text')
    expect(first).toMatchObject({ type: 'text', text: EXTRACTOR_INSTRUCTION, cache_control: { type: 'ephemeral' } })
  })

  it('картинка идёт ДО текстового контекста и помечена "Image 1:"', () => {
    const blocks = buildUserTurn({
      text: '2🎯',
      tMsg: '2026-06-24T20:13:11.000Z',
      openPositions: [],
      images: [{ base64: oneByOnePngB64, mediaType: 'image/jpeg' }],
    })

    const imageBlockIndex = blocks.findIndex((b) => b.type === 'image')
    const contextBlockIndex = blocks.findIndex((b) => b.type === 'text' && b.text.includes('MESSAGE TEXT:'))
    expect(imageBlockIndex).toBeGreaterThan(0)
    expect(imageBlockIndex).toBeLessThan(contextBlockIndex) // картинка до текстового контекста

    // Метка "Image 1:" — текстовый блок непосредственно перед image-блоком.
    const label = blocks[imageBlockIndex - 1]!
    expect(label).toMatchObject({ type: 'text' })
    expect(label.type === 'text' && label.text).toMatch(/^Image 1/)

    const imageBlock = blocks[imageBlockIndex]!
    expect(imageBlock).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: oneByOnePngB64 },
    })
  })

  it('контекст содержит t_msg, OPEN_POSITIONS (одна строка/позиция) и текст сообщения', () => {
    const blocks = buildUserTurn({
      text: 'Стоп на твх',
      tMsg: '2026-06-24T20:13:11.000Z',
      replyParentText: 'Теперь ест такой таргет',
      openPositions: [{ sym: 'SOLUSDT', side: 'long', legs: 2, avgEntry: 72.9, sl: 'BE', tpsLeft: [75, 76.5] }],
      images: [],
    })
    const ctx = blocks.find((b) => b.type === 'text' && b.text.includes('MESSAGE TEXT:'))
    expect(ctx && ctx.type === 'text' && ctx.text).toContain('t_msg=2026-06-24T20:13:11.000Z')
    expect(ctx && ctx.type === 'text' && ctx.text).toContain('[reply_to]: Теперь ест такой таргет')
    expect(ctx && ctx.type === 'text' && ctx.text).toContain('"sym":"SOLUSDT"')
    expect(ctx && ctx.type === 'text' && ctx.text).toContain('"sl":"BE"')
    expect(ctx && ctx.type === 'text' && ctx.text).toContain('Стоп на твх')
  })

  // Ветка терсных реплик («Sol 1🎯» <- «2🎯» <- «3🎯»): символ назван в корне, поэтому модель
  // должна видеть предков выше родителя и готовую подсказку движка (живой случай 09.08.2026).
  it('ветка реплаев и вычисленный символ ветки доезжают до модели', () => {
    const blocks = buildUserTurn({
      text: '3🎯',
      tMsg: '2026-08-09T15:43:59.000Z',
      replyParentText: '2🎯',
      replyChain: ['Sol 1🎯\nNext - 75.7, 77.2', '#SOLUSDT Long'],
      replyChainSymbol: 'SOLUSDT',
      openPositions: [{ sym: 'BTCUSDT', side: 'long', legs: 0, avgEntry: 64868, sl: 63200, tpsLeft: [65800, 66800, 67800] }],
      images: [],
    })
    const ctx = blocks.find((b) => b.type === 'text' && b.text.includes('MESSAGE TEXT:'))
    const text = ctx && ctx.type === 'text' ? ctx.text : ''
    expect(text).toContain('[reply_to]: 2🎯')
    expect(text).toContain('[reply_thread +2]: Sol 1🎯')
    expect(text).toContain('[reply_thread +3]: #SOLUSDT Long')
    expect(text).toContain('[reply_thread_symbol]: SOLUSDT')
  })
})

describeLive('callExtractSignal (живой ai-proxy) — требует AI_LIVE_TESTS=1', () => {
  let available = false
  beforeAll(async () => {
    available = await proxyAvailable()
    if (!available) console.warn('[ai-client.test] ai-proxy недоступен — живой тест пропущен')
  })

  it(
    "'2🎯' + карточка SOLUSDT → actions с symbol=SOLUSDT, image_used, evidence image/both",
    async () => {
      if (!available) {
        // Явный skip: прокси не поднят (офлайн/CI без доступа).
        return
      }
      const base64 = readFileSync(SOL_CARD_PATH).toString('base64')
      const result = await callExtractSignal({
        text: '2🎯',
        tMsg: '2026-06-28T00:00:00.000Z',
        openPositions: [],
        images: [{ base64, mediaType: 'image/jpeg' }],
      })

      // Фактический вывод — в консоль (задача просит привести реальный результат).
      console.log(
        '[live 2🎯] model=%s cacheHit=%s usage=%o message_type=%s actions=%o',
        result.model,
        result.cacheHit,
        result.usage,
        result.output.message_type,
        result.output.actions.map((a) => ({ type: a.type, symbol: a.symbol, side: a.side, ev: a.evidence_source })),
      )

      expect(result.output.image_used).toBe(true)
      expect(result.output.actions.length).toBeGreaterThan(0)
      const solAction = result.output.actions.find((a) => a.symbol === 'SOLUSDT')
      expect(solAction, 'ожидали хотя бы один action с symbol=SOLUSDT (из картинки)').toBeDefined()
      expect(['image', 'both']).toContain(solAction!.evidence_source)
    },
    60_000,
  )
})

// ---------------------------------------------------------------------------
// Important #1 адверсариального ревью (p2-final-fix-report.md): fetch без AbortController мог
// зависнуть неопределённо долго (дефолты undici) и держать открытой транзакцию pipeline.ts::
// runAiBranch. ЧИСТЫЙ тест — мокаем global.fetch зависшим (никогда не резолвится САМ, реджектится
// ТОЛЬКО при abort от AbortController — так же ведёт себя реальный fetch с переданным signal) и
// проверяем, что callExtractSignal НЕ висит: таймаут короткий (timeoutMs, параметр, а НЕ дефолтные
// 40с), а vi.useFakeTimers ускоряет backoff-паузы между 4 попытками (2с/4с/8с) — тест не ждёт их
// реальным временем.
// ---------------------------------------------------------------------------

describe('callExtractSignal — таймаут зависшего fetch (Important #1)', () => {
  it('зависший fetch (никогда не резолвится сам) не вешает callExtractSignal — abort по таймауту, throw после исчерпания ретраев', async () => {
    vi.useFakeTimers()
    const originalFetch = global.fetch

    // Мок fetch: промис никогда не резолвится сам по себе — реджектится ТОЛЬКО когда сработает
    // signal.abort() (ровно так себя ведёт настоящий fetch с переданным AbortSignal).
    global.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })) as typeof fetch

    try {
      const resultPromise = callExtractSignal({
        text: '2🎯',
        tMsg: '2026-06-24T20:13:11.000Z',
        openPositions: [],
        images: [],
        timeoutMs: 50, // короткий таймаут для теста — НЕ дефолтные 40с (задача просит не ждать 40с×4)
      })
      const assertion = expect(resultPromise).rejects.toThrow()

      // Продвигаем фейковое время: 4 попытки × abort-таймаут(50мс) + backoff между ними
      // (2с/4с/8с) — суммарно ~14.2с виртуального времени, БЕЗ реального ожидания.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1000)
      }

      await assertion
    } finally {
      global.fetch = originalFetch
      vi.useRealTimers()
    }
  }, 15_000)
})
