import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCh2 } from '../src/adapters/ch2.adapter.js'
import { resolveSymbol } from '../src/symbol-resolver.js'
import type { ParseContext, ParsedIntent } from 'shared/domain.js'

// Фикстура — дамп форума 1962583820, тема 173666 (100 реальных сообщений, research §0/§2).
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/ch2.jsonl', import.meta.url))

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

// research §8: все 29 символов дампа CH1 торгуются и на testnet, и на mainnet, за исключением
// GRASS/EIGEN (там нет в CH2). В CH2-дампе всего 5 монет (BTC/ETH/SOL/XRP/DOGE) — все
// листингованы на обеих сетях, поэтому isListed ≡ true (research §0: "isListed = всё торгуется").
const isListed = (): boolean => true

/**
 * ctx.resolveSymbol по контракту (research §10) — ЧИСТОЕ разрешение алиаса, без гейта по
 * листингу (листинг адаптер проверяет отдельно через ctx.isListed). Тот же приём, что и в
 * ch1.adapter.test.ts: существующий resolveSymbol(raw, isListed) объединяет оба шага, здесь
 * передаём always-true, чтобы получить только резолюцию алиаса.
 */
const alwaysListed = () => true

function buildContext(messages: FixtureMessage[]): (message: FixtureMessage) => ParseContext {
  const byId = new Map(messages.map((m) => [m.id, m]))
  return (message: FixtureMessage): ParseContext => ({
    channelId: '1962583820',
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
const results = fixture.map((message) => ({ message, result: parseCh2(makeContext(message)) }))

function byId(id: number) {
  const found = results.find((r) => r.message.id === id)
  if (!found) throw new Error(`Сообщение ${id} отсутствует в фикстуре`)
  return found
}

function deltaSymbols(intents: ParsedIntent[]): (string | null)[] {
  return intents.map((i) => ('symbol' in i ? i.symbol : null))
}

describe('ch2.adapter — агрегат покрытия на 100 реальных сообщениях (research §0)', () => {
  it('всего 100 сообщений в фикстуре', () => {
    expect(fixture.length).toBe(100)
  })

  // research §0 цель: DET≈35, AI≈31, NOISE≈34 (±3). Фактический прогон: execute=36, ai=34,
  // noise=30 (см. .superpowers/sdd/p2-task3-report.md — там же разбивка по под-правилам и
  // объяснение, почему noise на 1 сообщение ниже полосы допуска: несколько сообщений с
  // "стоп"/"фикс"/"объём" внутри условных/справочных конструкций ("можно…", "лучше…", "с учётом…")
  // намеренно исключены из ai в пользу noise — see SUGGESTION_MARKER_RE в ch2.adapter.ts).
  it('DET (route execute) — факт 36 (research: 35, ±3)', () => {
    const det = results.filter((r) => r.result.route === 'execute').length
    expect(det).toBeGreaterThanOrEqual(32)
    expect(det).toBeLessThanOrEqual(38)
  })

  // Раньше здесь стояло 28..34: всё, что не попало в узкий AI_LEXICON_RE, молча уходило в noise —
  // и модель не вызывалась даже на «SOL long» и «вход с текущих BTC long, риск 2%». Теперь непонятое
  // с монетой ИЛИ торговым маркером уходит в AI (фолбэк, как в CH1). Замер на этой же фикстуре: 46.
  // Верхняя граница сторожит ЦЕНУ: если доля AI поползёт вверх — значит гейт стал пропускать болтовню.
  it('AI (route ai) — фолбэк непонятого: 46 из 100 (было 34, всё остальное молча гасилось в noise)', () => {
    const ai = results.filter((r) => r.result.route === 'ai').length
    expect(ai).toBeGreaterThanOrEqual(42)
    expect(ai).toBeLessThanOrEqual(50)
  })

  // Бесплатно отсекается только то, где разбирать нечего: пустые медиа-посты, обзоры/анонсы,
  // советы («можно…», «лучше…») и болтовня без монеты и без торговых слов.
  it('NOISE — 18 из 100: бесплатно гасится болтовня, но не сигналы', () => {
    const noise = results.filter((r) => r.result.route === 'noise').length
    expect(noise).toBeGreaterThanOrEqual(15)
    expect(noise).toBeLessThanOrEqual(22)
  })

  it('route — ровно один из четырёх для каждого сообщения', () => {
    for (const { result } of results) {
      expect(['execute', 'ai', 'skip', 'noise']).toContain(result.route)
    }
  })

  it('ложных entry_signal вне гейта A не бывает: любой execute-intent kind=entry_signal имеет #TICKERUSDT+Entry price+Targets в исходном тексте', () => {
    for (const { message, result } of results) {
      const hasEntrySignal = result.intents.some((i) => i.kind === 'entry_signal')
      if (hasEntrySignal) {
        expect(/#([a-zA-Z]{2,10})usdt/i.test(message.text)).toBe(true)
        expect(/entry price/i.test(message.text)).toBe(true)
      }
    }
  })
})

describe('ch2.adapter — точечные проверки (task-3-brief.md)', () => {
  it('221443 → entry_signal SOLUSDT long, entry-диапазон, tps сплитнуты, sl (structured signal с префиксом-текстом перед блоком)', () => {
    const { result } = byId(221443)
    expect(result.route).toBe('execute')
    expect(result.confidence).toBe(1.0)
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('entry_signal')
    if (intent.kind !== 'entry_signal') throw new Error('unreachable')
    expect(intent.symbol).toBe('SOLUSDT')
    expect(intent.side).toBe('long')
    expect(intent.entry).toEqual([78.4, 78.5])
    expect(intent.tps).toEqual([79.9, 81.4, 83])
    expect(intent.sl).toBe(75.7)
  })

  it('221399/221408/221413/221433/221441/221451 — остальные 6 structured signal тоже execute entry_signal (7/7 итого, research §2 A)', () => {
    const ids = [221399, 221408, 221413, 221433, 221441, 221451]
    for (const id of ids) {
      const { result } = byId(id)
      expect(result.route, `msg ${id}`).toBe('execute')
      expect(result.intents[0]?.kind, `msg ${id}`).toBe('entry_signal')
    }
  })

  it('221428 "Limit long btc 60850 + limit long btc 60000\\nLimit long doge - 0.0728" → 3 ордера: BTC 60850, BTC 60000, DOGE 0.0728', () => {
    const { result } = byId(221428)
    expect(result.route).toBe('execute')
    // research §2 B полностью верифицирует все 3 сегмента этого сообщения (не только 2 BTC —
    // task-3-brief.md называет явно BTC-пару, doge — третий сегмент того же сообщения).
    expect(result.intents).toHaveLength(3)
    const btcOrders = result.intents.filter(
      (i): i is Extract<ParsedIntent, { kind: 'limit_entry' }> => i.kind === 'limit_entry' && i.symbol === 'BTCUSDT',
    )
    expect(btcOrders.map((o) => o.price)).toEqual(expect.arrayContaining([60850, 60000]))
    const dogeOrder = result.intents.find(
      (i): i is Extract<ParsedIntent, { kind: 'limit_entry' }> => i.kind === 'limit_entry' && i.symbol === 'DOGEUSDT',
    )
    expect(dogeOrder?.price).toBe(0.0728)
    for (const intent of result.intents) {
      expect(intent.kind).toBe('limit_entry')
      if (intent.kind === 'limit_entry') expect(intent.side).toBe('long')
    }
  })

  it('221377 "Перезахожу в Лонги Sol Eth btc" → market_entry [SOL,ETH,BTC], все long', () => {
    const { result } = byId(221377)
    expect(result.route).toBe('execute')
    expect(deltaSymbols(result.intents)).toEqual(
      expect.arrayContaining(['SOLUSDT', 'ETHUSDT', 'BTCUSDT']),
    )
    for (const intent of result.intents) {
      expect(intent.kind).toBe('market_entry')
      if (intent.kind === 'market_entry') expect(intent.side).toBe('long')
    }
  })

  it('"2🎯" (221354, 221398, 221427, 221437, 221438) → route ai (символ-less дельта, тейк-хит без тикера)', () => {
    for (const id of [221354, 221398, 221427, 221437, 221438]) {
      const { result } = byId(id)
      expect(result.route, `msg ${id}`).toBe('ai')
    }
  })

  it('"Фикс половину" (221447) → route ai (символ-less partial close)', () => {
    const { result } = byId(221447)
    expect(result.route).toBe('ai')
  })

  // Раньше эти посты гасились в noise ШАБЛОНОМ. Теперь они упоминают монету («на битке…»), поэтому
  // уходят в AI — и решение «сигнал это или рассуждение» принимает модель, а не regex. Это осознанная
  // плата: лучше отдать модели лишний абзац аналитики (она вернёт noise), чем молча потерять сигнал,
  // написанный в непривычной формулировке.
  it('аналитический абзац с упоминанием монеты → отдаётся AI, а не гасится шаблоном (221349, 221351, 221390)', () => {
    for (const id of [221349, 221351, 221390]) {
      const { message, result } = byId(id)
      expect(result.route, `msg ${id}: ${message.text.slice(0, 40)}`).toBe('ai')
      expect(result.intents, `msg ${id} — шаблон не должен выдумывать intent`).toEqual([])
    }
  })

  it('медиа-only без текста → route noise (221378-381, 221391, 221392, 221411)', () => {
    for (const id of [221378, 221379, 221380, 221381, 221391, 221392, 221411]) {
      const { message, result } = byId(id)
      expect(message.text.trim(), `msg ${id} должен быть пустым в фикстуре`).toBe('')
      expect(result.route, `msg ${id}`).toBe('noise')
    }
  })

  // E1 (research §7): символ дельты — reply-parent, а НЕ первое коин-слово во ВСЁМ сообщении.
  it('221445 "Sl 74\\nМожет быть финальный вынос по битку" (E1) — НЕ извлекается ложный BTCUSDT sl=74 из слова "по битку"', () => {
    const { result } = byId(221445)
    const hasFalseBtcSl = result.intents.some(
      (i) =>
        i.kind === 'delta' &&
        i.symbol === 'BTCUSDT' &&
        i.ops.some((op) => op.op === 'sl_set' && op.price === 74),
    )
    expect(hasFalseBtcSl, 'символ дельты не должен резолвиться из посторонней фразы "по битку"').toBe(false)

    // Наша реализация идёт дальше требования "не BTC": reply 221445→221443 — структурный
    // #SOLUSDT-сигнал, поэтому символ берётся из reply-родителя (research §7 вывод: reply
    // приоритетнее «первого коин-слова»), а не просто помечается ai. Оба исхода допустимы по
    // task-3-brief.md ("либо route ai … либо SL для символа из reply") — здесь route execute.
    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.symbol).toBe('SOLUSDT')
    expect(intent.ops).toEqual([{ op: 'sl_set', price: 74 }])
  })

  it('221355 "Sl btc - 64300\\n\\nSl Eth - 1730" → 2 дельты (BTC sl=64300, ETH sl=1730) — построчный сплит, не теряет второй ордер', () => {
    const { result } = byId(221355)
    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(2)
    const btc = result.intents.find((i) => i.kind === 'delta' && i.symbol === 'BTCUSDT')
    const eth = result.intents.find((i) => i.kind === 'delta' && i.symbol === 'ETHUSDT')
    expect(btc?.kind === 'delta' && btc.ops).toEqual([{ op: 'sl_set', price: 64300 }])
    expect(eth?.kind === 'delta' && eth.ops).toEqual([{ op: 'sl_set', price: 1730 }])
  })

  it('221421 "Sol Sl на твх \\nЛимитка не актуальна не задели \\nСледующие цели 75, 76.5" — sl_breakeven БЕЗ price (число цели не затягивается как цена SL)', () => {
    const { result } = byId(221421)
    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.symbol).toBe('SOLUSDT')
    expect(intent.ops).toEqual([{ op: 'sl_breakeven' }])
  })

  it('221361 "Стоп на твх Eth" → delta ETHUSDT sl_breakeven (be-маркер без reply, тикер прямо в тексте)', () => {
    const { result } = byId(221361)
    expect(result.route).toBe('execute')
    expect(result.intents).toEqual([{ kind: 'delta', symbol: 'ETHUSDT', ops: [{ op: 'sl_breakeven' }] }])
  })

  it('221405 "можно со стопом 68.2" → route noise (предложение/совет, не приказ — SUGGESTION_MARKER_RE)', () => {
    const { result } = byId(221405)
    expect(result.route).toBe('noise')
  })

  // Раньше это сообщение уходило в модель: шаблон не умел разбирать строку с целями, и маршрут
  // был единственным способом её не потерять. С правилом «цель + тикер + цена» (02.08.2026)
  // шаблон даёт ровно тот же tp_set, что вернула бы модель, — мгновенно и бесплатно. Маршрут
  // изменился осознанно; проверяем теперь не его, а сам разбор.
  it('221452 "По битку следующие цели 63700, 64600" (AMEND) → tp_set обеими целями, без вызова модели', () => {
    const { result } = byId(221452)
    expect(result.route).toBe('execute')
    const delta = result.intents.find((i): i is Extract<ParsedIntent, { kind: 'delta' }> => i.kind === 'delta')
    expect(delta?.symbol).toBe('BTCUSDT')
    expect(delta?.ops[0]).toMatchObject({ op: 'tp_set', targets: [{ value: 63700 }, { value: 64600 }] })
  })

  it('221393 "С текущих беру" (гейт market_entry сработал, символа в тексте нет) → route ai, не execute с пустыми intents', () => {
    const { result } = byId(221393)
    expect(result.route).toBe('ai')
    expect(result.intents).toHaveLength(0)
  })
})

// Регрессия на живых сообщениях заказчика в тестовом канале. До фолбэка ВСЕ они получали
// status='noise', method=NULL — модель не вызывалась ни разу, и канал, созданный ровно под AI-разбор
// свободного текста, не торговал вообще ничем.
describe('ch2.adapter — свободный текст доходит до AI (регрессия тестового канала)', () => {
  function ctxFor(text: string): ParseContext {
    return {
      channelId: '4322601605',
      message: { id: 1, text, date: '2026-07-13T15:00:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }

  it('«SOL long» -> AI (раньше молчаливый noise)', () => {
    expect(parseCh2(ctxFor('SOL long')).route).toBe('ai')
  })

  it('«вход с текущий BTC long, риск 2%» -> AI', () => {
    expect(parseCh2(ctxFor('вход с текущий BTC long, риск 2%')).route).toBe('ai')
  })

  // Стемы обязаны ловить словоформы: «зайд» → «зайду». С границей справа этот сигнал уходил в noise.
  it('«зайду от 76.3» (лимитный вход без монеты в тексте) -> AI', () => {
    expect(parseCh2(ctxFor('зайду от 76.3')).route).toBe('ai')
  })

  it('«долил соль» -> AI', () => {
    expect(parseCh2(ctxFor('долил соль')).route).toBe('ai')
  })

  it('болтовня без монеты и торговых слов -> noise (в модель не тащим)', () => {
    expect(parseCh2(ctxFor('привет, как дела')).route).toBe('noise')
    expect(parseCh2(ctxFor('да, согласен полностью')).route).toBe('noise')
  })

  it('обзор/анонс -> noise бесплатно', () => {
    expect(parseCh2(ctxFor('Итоги недели: обзор рынка')).route).toBe('noise')
  })
})

// Цена стопа — число рядом со словом «стоп», хоть слева, хоть справа. «Первое число строки» ставило
// $50 на BTC из «Фикс 50% BTC, стоп 70000»; «только хвост после маркера» терял «74600 стоп по битку».
describe('ch2.adapter — цена стопа берётся у маркера, а не соседнее число', () => {
  function ctx(text: string): ParseContext {
    return {
      channelId: '4322601605',
      message: { id: 1, text, date: '2026-07-13T00:00:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }
  const sl = (text: string) =>
    parseCh2(ctx(text)).intents.flatMap((i) => (i.kind === 'delta' ? i.ops : [])).find((o) => o.op === 'sl_set')

  it('цена ПЕРЕД маркером: «74600 стоп по битку» -> 74600', () => {
    expect(sl('74600 стоп по битку')).toEqual({ op: 'sl_set', price: 74600 })
  })

  it('процент не берётся за цену: «Фикс 50% BTC, стоп 70000» -> 70000, а не 50', () => {
    expect(sl('Фикс 50% BTC, стоп 70000')).toEqual({ op: 'sl_set', price: 70000 })
  })

  it('среди целей выбирается число у маркера: «цели 75000 76000 стоп 74600 по битку» -> 74600', () => {
    expect(sl('цели 75000 76000 стоп 74600 по битку')).toEqual({ op: 'sl_set', price: 74600 })
  })
})

// «Ещё один Лонг битка с текущих» (живой случай прода 29.07.2026, сообщение 221534). Разбор отдал
// новый market_entry, символ был занят открытой сделкой, и прямое указание автора долить позицию
// ушло в skip(symbol_busy). Отличать добор от ПОВТОРЁННОГО сигнала обязательно: дубль по занятому
// символу skip'ается намеренно (иначе позиция удвоилась бы), а «ещё один» — это команда долить.
describe('ch2.adapter — «ещё один» по занятому символу это ДОБОР, а не новый вход', () => {
  function ctxWith(text: string, open: string[]): ParseContext {
    return {
      channelId: '1962583820',
      message: { id: 1, text, date: '2026-07-29T20:04:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(
        open.map((symbol) => [symbol, { tradeId: 't-1', side: 'long' as const, openedByChannel: '1962583820' }]),
      ),
      lastTouchedSymbol: null,
    }
  }

  it('позиция по символу ОТКРЫТА -> add, а не market_entry', () => {
    const result = parseCh2(ctxWith('Ещё один Лонг битка с текущих', ['BTCUSDT']))

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    expect(result.intents[0]).toMatchObject({ kind: 'add', symbol: 'BTCUSDT', side: 'long' })
  })

  it('позиции по символу НЕТ -> обычный вход (автор мог закрыть прошлую сделку раньше)', () => {
    const result = parseCh2(ctxWith('Ещё один Лонг битка с текущих', []))

    expect(result.intents[0]).toMatchObject({ kind: 'market_entry', symbol: 'BTCUSDT', side: 'long' })
  })

  it('ПОВТОРЁННЫЙ сигнал без слова «ещё» по занятому символу -> остаётся market_entry (дубль обязан скипаться)', () => {
    const result = parseCh2(ctxWith('Лонг битка с текущих', ['BTCUSDT']))

    expect(result.intents[0]).toMatchObject({ kind: 'market_entry', symbol: 'BTCUSDT' })
  })

  it('«добираю»/«усредняю» по занятому символу -> тоже add', () => {
    for (const text of ['Добираю битка с текущих', 'Усредняю лонг битка с текущих']) {
      const result = parseCh2(ctxWith(text, ['BTCUSDT']))
      expect(result.intents[0], text).toMatchObject({ kind: 'add', symbol: 'BTCUSDT' })
    }
  })
})

// Живой случай 02.08.2026: сообщение из трёх строк — закрытие Соланы, стоп по битку и первый тейк
// по битку. Правило D смотрело ТОЛЬКО на строки со стопом, поэтому давало один интент, а две
// другие инструкции молча пропадали: маршрут оставался детерминированным, и модель к ним не
// вызывалась. Тейк по битку не был выставлен вовсе.
describe('ch2.adapter — построчные инструкции: стоп, цель и выход в одном сообщении', () => {
  function ctxFor(text: string): ParseContext {
    return {
      channelId: '1962583820',
      message: { id: 1, text, date: '2026-08-02T20:14:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }
  const deltas = (text: string) =>
    parseCh2(ctxFor(text)).intents.filter((i): i is Extract<ParsedIntent, { kind: 'delta' }> => i.kind === 'delta')

  it('все три строки дают свою инструкцию по своему символу', () => {
    const result = deltas('Около бу закрываю Солану\nПо битку ставлю стоп в бу на 63000\nПервый тейк по битку 63950')

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ symbol: 'SOLUSDT', ops: [{ op: 'close_remainder' }] })
    expect(result[1]?.symbol).toBe('BTCUSDT')
    expect(result[1]?.ops[0]?.op).toBe('sl_breakeven')
    expect(result[2]).toMatchObject({ symbol: 'BTCUSDT', ops: [{ op: 'tp_set', targets: [{ value: 63950, index: 1 }] }] })
  })

  it('порядковое слово даёт номер ступени лесенки — по нему закроется доля, а не весь объём', () => {
    expect(deltas('Второй тейк по битку 63950')[0]?.ops[0]).toMatchObject({ op: 'tp_set', targets: [{ value: 63950, index: 2 }] })
    // Без порядкового слова номер неизвестен — пайплайн сам решит размер ступени.
    expect(deltas('Цель по битку 63950')[0]?.ops[0]).toMatchObject({ op: 'tp_set', targets: [{ value: 63950 }] })
  })

  it('строка со стопом забирает своё число, даже если рядом слово «цель»', () => {
    const result = deltas('По битку стоп 63000, дальше цели обновлю')

    expect(result[0]?.ops[0]).toMatchObject({ op: 'sl_set', price: 63000 })
  })

  it('«не закрываю» не превращается в выход из позиции', () => {
    expect(deltas('Солану пока не закрываю, держим')).toHaveLength(0)
  })

  it('«фиксирую 50% по солане» -> частичная фиксация с долей автора', () => {
    expect(deltas('Фиксирую 50% по солане')[0]?.ops[0]).toMatchObject({ op: 'partial_close', fraction: 0.5 })
  })
})

// Тот же класс ошибки в свободном канале: «фиксирую половину» не должно закрывать всю позицию,
// а «фиксирую позицию» — должно. Голое «фиксирую» без уточнения трактуем как долю: закрыть по нему
// всё было бы дороже ошибкой, чем закрыть половину.
describe('ch2.adapter — доля против полного выхода', () => {
  function ctxFor(text: string): ParseContext {
    return {
      channelId: '1962583820',
      message: { id: 1, text, date: '2026-08-05T10:04:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }
  const op = (text: string) => {
    const delta = parseCh2(ctxFor(text)).intents.find((i): i is Extract<ParsedIntent, { kind: 'delta' }> => i.kind === 'delta')
    return delta?.ops[0]
  }

  it('«фиксирую позицию по битку» -> полный выход', () => {
    expect(op('Фиксирую позицию по битку')).toEqual({ op: 'close_remainder' })
  })

  it('доли словами и процентом -> частичная фиксация', () => {
    expect(op('Фиксирую половину по битку')).toEqual({ op: 'partial_close', fraction: 0.5 })
    expect(op('Фиксирую треть по битку')).toMatchObject({ op: 'partial_close' })
    expect(op('Фиксирую 30% по битку')).toEqual({ op: 'partial_close', fraction: 0.3 })
    expect(op('Фиксирую часть по битку')).toEqual({ op: 'partial_close' })
  })

  it('«закрываю биток» — полный выход даже без слова «позиция»', () => {
    expect(op('Закрываю биток')).toEqual({ op: 'close_remainder' })
  })

  it('доля важнее слова «позиция»: «фиксирую 50% позиции по битку»', () => {
    expect(op('Фиксирую 50% позиции по битку')).toEqual({ op: 'partial_close', fraction: 0.5 })
  })
})

// Живой случай прода 06.08.2026 (msg 221563, канал AACADEMY): три строки — рыночный вход по XRP и
// две лимитки. Правила B и C стояли в цепочке «первый матч выигрывает»: B вернул две лимитки и
// остановил разбор, C не запускался вовсе — по XRP не появилось ни ордера, ни даже строки действия.
describe('ch2.adapter — рыночный вход и лимитки в ОДНОМ сообщении', () => {
  function ctxWith(text: string, open: string[] = []): ParseContext {
    return {
      channelId: '1962583820',
      message: { id: 1, text, date: '2026-08-06T08:26:00Z', replyToMsgId: null, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: () => null,
      openPositions: new Map(
        open.map((symbol) => [symbol, { tradeId: 't-1', side: 'long' as const, openedByChannel: '1962583820' }]),
      ),
      lastTouchedSymbol: null,
    }
  }

  it('«С текущих long Xrp» + две лимитки → ТРИ интента в порядке строк', () => {
    const result = parseCh2(ctxWith('С текущих long Xrp\nLimit long Eth - 1895\nLimit long SOL - 73.1'))

    expect(result.route).toBe('execute')
    expect(result.intents).toEqual([
      { kind: 'market_entry', symbol: 'XRPUSDT', side: 'long' },
      { kind: 'limit_entry', symbol: 'ETHUSDT', side: 'long', price: 1895 },
      { kind: 'limit_entry', symbol: 'SOLUSDT', side: 'long', price: 73.1 },
    ])
  })

  it('лимитка первой строкой, рыночный вход второй — порядок интентов совпадает с текстом', () => {
    const result = parseCh2(ctxWith('Limit long Eth - 1895\nПерезахожу с текущих в btc long'))

    expect(result.intents.map((i) => ('symbol' in i ? i.symbol : null))).toEqual(['ETHUSDT', 'BTCUSDT'])
  })

  it('рыночная строка С ЧИСЛОМ не превращается в лимитку', () => {
    const result = parseCh2(ctxWith('С текущих long Xrp по 0.62\nLimit long Eth - 1895'))

    expect(result.intents).toEqual([
      { kind: 'market_entry', symbol: 'XRPUSDT', side: 'long' },
      { kind: 'limit_entry', symbol: 'ETHUSDT', side: 'long', price: 1895 },
    ])
  })

  it('символ, вошедший лимиткой, не дублируется рыночным входом', () => {
    const result = parseCh2(ctxWith('Limit long Eth - 1895\nС текущих тоже беру eth long'))

    expect(result.intents).toHaveLength(1)
    expect(result.intents[0]).toMatchObject({ kind: 'limit_entry', symbol: 'ETHUSDT' })
  })

  it('«добираю» в рыночной строке остаётся ДОБОРОМ и рядом с лимиткой', () => {
    const result = parseCh2(ctxWith('Добираю битка с текущих\nLimit long Eth - 1895', ['BTCUSDT']))

    expect(result.intents).toEqual([
      { kind: 'add', symbol: 'BTCUSDT', side: 'long' },
      { kind: 'limit_entry', symbol: 'ETHUSDT', side: 'long', price: 1895 },
    ])
  })

  it('половина сообщения не разобралась → всё сообщение уходит в AI, а не исполняется частично', () => {
    const result = parseCh2(ctxWith('С текущих беру\nLimit long Eth - 1895'))

    expect(result.route).toBe('ai')
    expect(result.reason).toBe('partial_entry_parse')
    expect(result.intents).toHaveLength(0)
  })

  it('одни лимитки без рыночных фраз — прежние маршрут и уверенность (0.8)', () => {
    const result = parseCh2(ctxWith('Limit long btc 60850 + limit long btc 60000\nLimit long doge - 0.0728'))

    expect(result.route).toBe('execute')
    expect(result.confidence).toBe(0.8)
    expect(result.intents).toHaveLength(3)
  })
})

// Живой случай 09.08.2026 (msg 221572, канал AACADEMY): автор ведёт позицию цепочкой терсных
// реплик — «Sol 1🎯» ← «2🎯» ← «3🎯». Символ назван ОДИН раз, в корне ветки. Контекст знал ровно
// одного родителя, и на втором хопе символ терялся: тейк по солане уехал на биток.
describe('ch2.adapter — символ берётся из ЦЕПОЧКИ реплаев, а не только у прямого родителя', () => {
  /** @param chain сообщения ветки: ключ — tg id, значение — [текст, id родителя]. */
  function ctxWithChain(text: string, replyToMsgId: number | null, chain: Record<number, [string, number | null]>): ParseContext {
    return {
      channelId: '1962583820',
      message: { id: 999, text, date: '2026-08-09T15:43:00Z', replyToMsgId, groupedId: null, media: null, mediaFile: null },
      resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
      isListed,
      getMessage: (id: number) => {
        const found = chain[id]
        if (!found) return null
        return { id, text: found[0], date: '2026-08-09T00:00:00Z', replyToMsgId: found[1], groupedId: null, media: null, mediaFile: null }
      },
      openPositions: new Map(),
      lastTouchedSymbol: null,
    }
  }

  it('символ найден через ДВА хопа вверх по ветке', () => {
    const result = parseCh2(
      ctxWithChain('Стоп в бу', 221570, {
        221570: ['2🎯', 221569],
        221569: ['Sol 1🎯\nNext - 75.7, 77.2', 221564],
      }),
    )

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    expect(result.intents[0]).toMatchObject({ kind: 'delta', symbol: 'SOLUSDT', ops: [{ op: 'sl_breakeven' }] })
  })

  it('ближайший предок с символами называет их НЕСКОЛЬКО -> не гадаем, отдаём в AI', () => {
    const result = parseCh2(
      ctxWithChain('Стоп в бу', 100, {
        100: ['Sl btc 60000\nSl Eth 1800', 99],
        99: ['Sol long с текущих', null],
      }),
    )

    expect(result.route).toBe('ai')
    expect(result.intents).toHaveLength(0)
  })

  it('ветка глубже лимита хопов -> символ не выдумывается', () => {
    const chain: Record<number, [string, number | null]> = {}
    for (let i = 0; i < 8; i++) chain[200 + i] = ['🎯', 200 + i + 1]
    chain[208] = ['Sol 1🎯', null]

    const result = parseCh2(ctxWithChain('Стоп в бу', 200, chain))

    expect(result.route).toBe('ai')
  })

  it('цикл в ветке (сообщение отвечает само себе) не зацикливает разбор', () => {
    const result = parseCh2(ctxWithChain('Стоп в бу', 300, { 300: ['2🎯', 300] }))

    expect(result.route).toBe('ai')
  })
})
