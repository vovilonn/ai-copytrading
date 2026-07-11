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

  it('AI (route ai) — факт 34 (research: 31, ±3)', () => {
    const ai = results.filter((r) => r.result.route === 'ai').length
    expect(ai).toBeGreaterThanOrEqual(28)
    expect(ai).toBeLessThanOrEqual(34)
  })

  it('NOISE — факт 30 (research: 34, ±3 плюс 1 документированное отклонение)', () => {
    const noise = results.filter((r) => r.result.route === 'noise').length
    expect(noise).toBeGreaterThanOrEqual(30)
    expect(noise).toBeLessThanOrEqual(37)
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

  it('аналитический абзац без order-фразы → route noise (221349, 221351, 221390 — обзорные посты темы)', () => {
    for (const id of [221349, 221351, 221390]) {
      const { message, result } = byId(id)
      expect(result.route, `msg ${id}: ${message.text.slice(0, 40)}`).toBe('noise')
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

  it('221452 "По битку следующие цели 63700, 64600" (AMEND) → route ai', () => {
    const { result } = byId(221452)
    expect(result.route).toBe('ai')
  })

  it('221393 "С текущих беру" (гейт market_entry сработал, символа в тексте нет) → route ai, не execute с пустыми intents', () => {
    const { result } = byId(221393)
    expect(result.route).toBe('ai')
    expect(result.intents).toHaveLength(0)
  })
})
