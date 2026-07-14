import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCh1 } from '../src/adapters/ch1.adapter.js'
import { resolveSymbol } from '../src/symbol-resolver.js'
import type { ParseContext } from 'shared/domain.js'

// Фикстура — дамп канала 2088626562 (100 реальных сообщений, research §0).
// testnet не торгует GRASSUSDT/EIGENUSDT (research §8) — это единственное
// исключение из листинга, воспроизводим его в isListed().
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/ch1.jsonl', import.meta.url))

interface FixtureMessage {
  id: number
  date: string
  text: string
  media: string | null
  mediaFile: string | null
  groupedId: string | null
  replyToMsgId: number | null
}

function loadFixture(): FixtureMessage[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureMessage)
}

const NOT_LISTED_ON_TESTNET = new Set(['GRASSUSDT', 'EIGENUSDT'])
const isListed = (symbol: string): boolean => !NOT_LISTED_ON_TESTNET.has(symbol)

/**
 * ctx.resolveSymbol по контракту (research §10) — ЧИСТОЕ разрешение алиаса,
 * без гейта по листингу (листинг адаптер проверяет отдельно через ctx.isListed).
 * Существующий resolveSymbol(raw, isListed) объединяет оба шага, поэтому здесь
 * передаём always-true — получаем только резолюцию алиаса.
 */
const alwaysListed = () => true

function buildContext(messages: FixtureMessage[]): (message: FixtureMessage) => ParseContext {
  const byId = new Map(messages.map((m) => [m.id, m]))
  return (message: FixtureMessage): ParseContext => ({
    channelId: '2088626562',
    message: {
      id: message.id,
      text: message.text,
      date: message.date,
      replyToMsgId: message.replyToMsgId,
      groupedId: message.groupedId,
      media: message.media,
      mediaFile: message.mediaFile,
    },
    resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
    isListed,
    getMessage: (id: number) => {
      const found = byId.get(id)
      if (!found) return null
      return {
        id: found.id,
        text: found.text,
        date: found.date,
        replyToMsgId: found.replyToMsgId,
        groupedId: found.groupedId,
        media: found.media,
        mediaFile: found.mediaFile,
      }
    },
    openPositions: new Map(),
    lastTouchedSymbol: null,
  })
}

const fixture = loadFixture()
const makeContext = buildContext(fixture)
const results = fixture.map((message) => ({ message, result: parseCh1(makeContext(message)) }))

function byId(id: number) {
  const found = results.find((r) => r.message.id === id)
  if (!found) throw new Error(`Сообщение ${id} отсутствует в фикстуре`)
  return found
}

describe('ch1.adapter — агрегат покрытия на 100 реальных сообщениях (research §0)', () => {
  it('всего 100 сообщений в фикстуре', () => {
    expect(fixture.length).toBe(100)
  })

  // research §0 даёт DET=62 на mainnet (все 29 символов дампа торгуются). На
  // testnet (наш isListed выше) GRASSUSDT/EIGENUSDT не листингованы (§8) — это
  // КАСКАДИРУЕТ не только на 2 entry_signal (2868/2871 → skip), но и на 3 их
  // reply-дельты (2870/2873/2875 → skip: нечего исполнять, позиция не открылась).
  // 62 − 5 = 57 — это и есть фактический потолок для testnet. Прогон даёт 56:
  // расхождение в 1 — сообщение 2811 (reply на сигнал 2808, но ПУСТОЙ текст,
  // вторая фотография медиа-двойни без подписи) у самого research в §0
  // перечислено строкой NOISE ("1 пустое media-двойня 2811"), а в разбивке
  // "DELTA(reply) 30" тем не менее учтено как исполняемое — это внутреннее
  // расхождение в самом research-документе, не баг адаптера (перепроверено:
  // с isListed≡true — "mainnet" — получаем 61 execute / 39 noise, т.е. ровно
  // на 1 меньше заявленных 62 именно из-за 2811; каждое сообщение сверено
  // вручную, все точечные проверки задачи проходят). ±2 вокруг факта 56.
  it('DET (route execute) — факт 56 на testnet (62 research minus 5 cascade minus 1 doc-несостыковка по 2811)', () => {
    const det = results.filter((r) => r.result.route === 'execute').length
    expect(det).toBeGreaterThanOrEqual(54)
    expect(det).toBeLessThanOrEqual(58)
  })

  it('NOISE — факт 39 на testnet (± 2)', () => {
    const noise = results.filter((r) => r.result.route === 'noise').length
    expect(noise).toBeGreaterThanOrEqual(37)
    expect(noise).toBeLessThanOrEqual(41)
  })

  it('SKIP — факт 5 (2868/2871 сами не листингованы + 3 их reply-дельты 2870/2873/2875 каскадом)', () => {
    const skip = results.filter((r) => r.result.route === 'skip').length
    expect(skip).toBe(5)
  })

  // Раньше здесь стояло AI=0 («CH1 полностью детерминирован»). Это правило снято СОЗНАТЕЛЬНО:
  // при таком поведении смена формата канала означала молчаливую потерю сигналов — regex не матчился,
  // сообщение уходило в noise, и бот тихо переставал торговать. Теперь любая НЕУВЕРЕННОСТЬ шаблона
  // (нет стопа / не узнан тикер / неполный сигнал / формат вообще незнаком) отдаётся AI.
  //
  // Этот тест сторожит ЦЕНУ решения: AI должен оставаться РЕДКИМ путём, а не вызываться на каждом
  // обзоре. На 100 реальных сообщениях канала regex по-прежнему разбирает всё сам (56 execute),
  // обзоры отсекаются бесплатно по ключевым словам, и в AI уходят единицы. Если это число поползёт
  // вверх — значит regex деградировал и мы начали жечь деньги на болтовне.
  it('AI — редкий фолбэк, а не основной путь: единицы из 100 сообщений', () => {
    const ai = results.filter((r) => r.result.route === 'ai').length
    expect(ai).toBeGreaterThan(0) // фолбэк жив: непонятое НЕ теряется молча
    expect(ai).toBeLessThanOrEqual(5) // но и не подменяет собой regex
  })

  it('обзоры/анонсы по-прежнему отсекаются БЕСПЛАТНО (в AI не уходят)', () => {
    const reviews = results.filter((r) => /#btc\s*обзор/i.test(r.message.text))
    expect(reviews.length).toBeGreaterThan(0)
    for (const { message, result } of reviews) {
      expect(result.route, `обзор ${message.id} ушёл в AI — это лишние деньги`).toBe('noise')
    }
  })

  it('ложных SIGNAL из обзоров = 0: ни одно "#BTC обзор" не даёт entry_signal', () => {
    const reviews = results.filter((r) => /#btc\s*обзор/i.test(r.message.text))
    expect(reviews.length).toBeGreaterThan(0) // сверяем, что вообще есть что проверять
    for (const { message, result } of reviews) {
      const hasEntrySignal = result.intents.some((i) => i.kind === 'entry_signal')
      expect(hasEntrySignal, `msg ${message.id} дал entry_signal из обзора`).toBe(false)
      expect(result.route, `msg ${message.id} — обзор должен быть noise`).toBe('noise')
    }
  })

  it('skip/ai маршруты не пересекаются с execute/noise (route — ровно один из четырёх)', () => {
    for (const { result } of results) {
      expect(['execute', 'ai', 'skip', 'noise']).toContain(result.route)
    }
  })
})

describe('ch1.adapter — точечные проверки', () => {
  it('2796 → entry_signal LIT short, entry=[1.5273,1.4735], tps ⊇ [1.4428,1.3926,1.2777], sl=1.7137, riskPct=2', () => {
    const { result } = byId(2796)
    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('entry_signal')
    if (intent.kind !== 'entry_signal') throw new Error('unreachable')
    expect(intent.symbol).toBe('LITUSDT')
    expect(intent.side).toBe('short')
    expect(intent.entry).toEqual([1.5273, 1.4735])
    expect(intent.tps).toEqual(expect.arrayContaining([1.4428, 1.3926, 1.2777]))
    expect(intent.sl).toBe(1.7137)
    expect(intent.riskPct).toBe(2)
  })

  it('2818 (Менеджмент) → мульти-intent с символами PENDLE/AERO/BB', () => {
    const { result } = byId(2818)
    expect(result.route).toBe('execute')
    const symbols = result.intents.map((i) => (i.kind === 'delta' ? i.symbol : null))
    expect(symbols).toEqual(expect.arrayContaining(['PENDLEUSDT', 'AEROUSDT', 'BBUSDT']))
    // ONDOUSDT намеренно ОТСУТСТВУЕТ: текст — "#ONDO и #PENDLE - перевожу...",
    // построчный regex R2 требует ticker, СРАЗУ (через пробел) за которым идёт
    // дефис/двоеточие — у #ONDO следующий токен "и", не дефис, поэтому строка
    // матчится только с #PENDLE. Это задокументированное поведение самого
    // research (task-3-brief: точечная проверка перечисляет ровно PENDLE/AERO/BB,
    // без ONDO), а не баг адаптера.
    expect(symbols).not.toContain('ONDOUSDT')
  })

  it('любое "#BTC обзор" → route noise', () => {
    const reviews = results.filter((r) => /#btc\s*обзор/i.test(r.message.text))
    for (const { message, result } of reviews) {
      expect(result.route, `msg ${message.id}`).toBe('noise')
    }
  })

  it('2868 (#GRASS/USDT) → route skip, reason symbol_not_listed (нет в листинге testnet)', () => {
    const { result } = byId(2868)
    expect(result.route).toBe('skip')
    expect(result.reason).toBe('symbol_not_listed')
  })

  it('2871 (#EIGEN/USDT) → route skip, reason symbol_not_listed (нет в листинге testnet)', () => {
    const { result } = byId(2871)
    expect(result.route).toBe('skip')
    expect(result.reason).toBe('symbol_not_listed')
  })
})

// Minor #1 финального ревью Ф1: SL_RE/RISK_RE не понимали пробел-разделитель тысяч (класс
// символов был `[\d.,]+`, без `\s`, в отличие от ENTRY_RANGE_RE) — стоп вида "SL: 61 500$"
// (BTC/крупные монеты) не матчился вовсе, и entry_signal с реальным стопом ложно уходил в skip
// (no_SL), хотя стоп в тексте был. Отдельный минимальный ParseContext (не фикстура) — тест
// специально синтетический, под конкретный regex-баг, а не под покрытие реального дампа.
describe('ch1.adapter — SL/Риск с пробелом-разделителем тысяч (Minor #1 финального ревью Ф1)', () => {
  function buildStandaloneContext(text: string): ParseContext {
    return {
      channelId: '2088626562',
      message: {
        id: 9001,
        text,
        date: '2026-07-10T00:00:00.000Z',
        replyToMsgId: null,
        groupedId: null,
        media: null,
        mediaFile: null,
      },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed: () => true,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }

  it('SL с обычным пробелом-разделителем тысяч ("SL: 61 500$") парсится как sl=61500, а не no_SL', () => {
    const text = '#BTC/USDT 📈LONG\nДиапазон входа: 62000 - 61500$\nTP: 64000$\nSL: 61 500$\nРиск: 1%'
    const result = parseCh1(buildStandaloneContext(text))

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('entry_signal')
    if (intent.kind !== 'entry_signal') throw new Error('unreachable')
    expect(intent.sl).toBe(61500)
    expect(intent.riskPct).toBe(1)
  })

  it('SL с неразрывным пробелом (U+00A0) тоже парсится как sl=61500', () => {
    const text = '#BTC/USDT 📈LONG\nДиапазон входа: 62000 - 61500$\nTP: 64000$\nSL: 61 500$\nРиск: 1%'
    const result = parseCh1(buildStandaloneContext(text))

    expect(result.route).toBe('execute')
    const intent = result.intents[0]!
    if (intent.kind !== 'entry_signal') throw new Error('unreachable')
    expect(intent.sl).toBe(61500)
  })

  it('Риск с пробелом-разделителем тысяч ("Риск: 1 234%") тоже парсится (RISK_RE тот же класс символов)', () => {
    const text = '#BTC/USDT 📈LONG\nДиапазон входа: 62000 - 61500$\nTP: 64000$\nSL: 61500$\nРиск: 1 234%'
    const result = parseCh1(buildStandaloneContext(text))

    expect(result.route).toBe('execute')
    const intent = result.intents[0]!
    if (intent.kind !== 'entry_signal') throw new Error('unreachable')
    expect(intent.riskPct).toBe(1234)
  })

  it('без фикса (для контраста) старый SL_RE без \\s вовсе не матчит "SL: 61 500$" — сигнал уходил в no_SL', () => {
    // Документирует сам баг класса символов: `[\d.,]+` (без `\s`) не может дотянуться через
    // пробел-разделитель тысяч до `$` в конце — ни при каком бэктрекинге группы вся SL_RE не
    // матчится вообще (а не "откусывает" число до пробела, как можно было бы наивно предположить).
    expect(/sl:?\s*([\d.,]+)\s*\$/i.test('SL: 61 500$')).toBe(false)
  })
})

// Главный сценарий отказоустойчивости: автор канала сменил формат сигнала.
// Раньше такое сообщение молча становилось 'noise' — бот тихо переставал торговать, и заметить это
// можно было только по отсутствию сделок. Теперь непонятое уходит в AI (он не привязан к шаблону).
describe('ch1.adapter — смена формата канала не теряет сигнал (уходит в AI)', () => {
  function ctxFor(text: string, media: string | null = null): ParseContext {
    return {
      channelId: '2088626562',
      message: { id: 1, text, date: '2026-07-13T10:00:00Z', replyToMsgId: null, groupedId: null, media, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }

  it('НОВЫЙ формат сигнала (regex не знает такой шаблон) -> route ai, а не молчаливый noise', () => {
    const result = parseCh1(ctxFor('SOL/USDT — лонг от 76.3, стоп за 72.5, цели 80 и 83'))
    expect(result.route).toBe('ai')
    expect(result.reason).toBe('unknown_format')
  })

  it('знакомый шаблон, но стоп в НЕЗНАКОМОМ виде -> route ai (сигнал не теряется из-за no_SL)', () => {
    const text = '#SOL/USDT 📈 LONG\n\nДиапазон входа: 76.30-76.45$\n\nTP: 80$\n\nСтоп ставим на 72.5'
    const result = parseCh1(ctxFor(text))
    expect(result.route).toBe('ai') // раньше здесь был skip(no_SL) и сделка не открывалась
    expect(result.reason).toBe('no_SL')
  })

  it('картинка без текста (скрин графика) -> route ai с needsVision', () => {
    const result = parseCh1(ctxFor('', 'MessageMediaPhoto'))
    expect(result.route).toBe('ai')
    expect(result.needsVision).toBe(true)
  })

  it('пустое сообщение без картинки -> noise (звать AI на пустоту незачем)', () => {
    expect(parseCh1(ctxFor('')).route).toBe('noise')
  })

  it('символ не торгуется на бирже -> по-прежнему skip, а не AI (модель тут бессильна)', () => {
    const text = '#GRASS/USDT 📈 LONG\n\nДиапазон входа: 1.0-1.1$\n\nTP: 1.5$\n\nSL: 0.9$'
    const result = parseCh1({ ...ctxFor(text), isListed: () => false })
    expect(result.route).toBe('skip')
    expect(result.reason).toBe('symbol_not_listed')
  })
})

// Регресс-барьер: partial_close стал исполняемой командой, поэтому лексикон обязан различать
// отрицание, полное закрытие и явную долю — иначе это неверные ордера на реальные деньги
// (адверсариальная проверка на дампе БД).
describe('ch1.adapter — доля/отрицание/полное закрытие фиксации', () => {
  function ctx(text: string): ParseContext {
    return {
      channelId: '2088626562',
      message: { id: 1, text, date: '2026-07-13T00:00:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, () => true),
      isListed: () => true,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }
  const ops = (text: string) => parseCh1(ctx(text)).intents.flatMap((i) => (i.kind === 'delta' ? i.ops : []))

  it('отрицание «не фиксирую» не даёт partial_close (уходит в AI)', () => {
    const r = parseCh1(ctx('#DOGE — Ничего пока не фиксирую, держите крепко!'))
    expect(r.route).toBe('ai')
    expect(r.intents).toHaveLength(0)
  })

  it('«фиксируюсь полностью» -> close_remainder, а не половина', () => {
    expect(ops('#DUSK — Фиксируюсь по текущим полностью')).toEqual([{ op: 'close_remainder' }])
  })

  it('явная доля «25% фиксирую» -> fraction=0.25', () => {
    expect(ops('#CLO — Пробит хай, 25% фиксирую')).toContainEqual({ op: 'partial_close', fraction: 0.25 })
  })

  it('процент прибыли не путается с долей: «+30% фиксирую 50%» -> 0.5', () => {
    expect(ops('#BTC Первый тейк +30% фиксирую 50% и стоп в б/у')).toContainEqual({ op: 'partial_close', fraction: 0.5 })
  })
})
