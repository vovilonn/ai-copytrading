import { describe, it, expect } from 'vitest'
import type { ExtractSignalAction, ExtractSignalOutput } from '../src/ai/schema.js'
import { normalizeAiOutput } from '../src/ai/normalize-output.js'

// normalizeAiOutput (задача 2 Ф2, research/ai-layer.md §3): чистые тесты, без сети/БД.

/** Минимальный action с дефолтами полей, которые тесту не важны. */
function action(overrides: Partial<ExtractSignalAction> & Pick<ExtractSignalAction, 'type' | 'symbol'>): ExtractSignalAction {
  return { side: 'long', evidence_source: 'text', ...overrides }
}

/** Минимальный output с дефолтами. */
function output(overrides: Partial<ExtractSignalOutput> & Pick<ExtractSignalOutput, 'actions'>): ExtractSignalOutput {
  return {
    understood: true,
    needs_human: false,
    message_type: 'management_multi',
    image_used: false,
    confidence: 0.9,
    summary: '',
    ...overrides,
  }
}

describe('normalizeAiOutput', () => {
  it('modify_sl marker=entry_price -> delta sl_breakeven БЕЗ числа', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'modify_sl',
        actions: [
          action({
            type: 'modify_sl',
            symbol: 'SOLUSDT',
            stop_loss: { mode: 'marker', marker: 'entry_price' },
          }),
        ],
      }),
    )

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('delta')
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.symbol).toBe('SOLUSDT')
    expect(intent.ops).toEqual([{ op: 'sl_breakeven' }])
    // Никакого числа нигде в op'е — маркер остаётся символьным (реальная цена — из состояния).
    expect(JSON.stringify(intent.ops)).not.toMatch(/\d/)
  })

  it('close_amount fraction 0.5 -> partial_close fraction 0.5', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'close_partial',
        actions: [
          action({
            type: 'close',
            symbol: 'BTCUSDT',
            close_amount: { mode: 'fraction', value: 0.5, basis: 'original' },
          }),
        ],
      }),
    )

    expect(result.route).toBe('execute')
    const intent = result.intents[0]!
    expect(intent.kind).toBe('delta')
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'partial_close', fraction: 0.5, basis: 'original' }])
  })

  it('close_amount units marker=one_unit -> partial_close с маркером «один объём» (без числа)', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'close_partial',
        actions: [
          action({
            type: 'close',
            symbol: 'BTCUSDT',
            close_amount: { mode: 'units', marker: 'one_unit' },
          }),
        ],
      }),
    )

    expect(result.route).toBe('execute')
    const intent = result.intents[0]!
    expect(intent.kind).toBe('delta')
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'partial_close', unit: 'one_unit' }])
  })

  it('symbol=UNKNOWN -> route needs_review (ai)', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        needs_human: true,
        actions: [
          action({
            type: 'open',
            symbol: 'UNKNOWN',
            side: 'long',
            order_type: 'market',
            evidence_source: 'image',
          }),
        ],
      }),
    )

    expect(result.route).toBe('ai') // Route Ф1 — reconciler.ts мапит его в outcome needs_review
    expect(result.reason).toBe('symbol_unknown_needs_vision')
    expect(result.intents).toHaveLength(0) // нечего резолвить — символ неизвестен
  })

  it('tp_hit -> delta tp_hit (событие, не entry)', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'position_event',
        actions: [action({ type: 'tp_hit', symbol: 'SOLUSDT', tp_index: 1, evidence_source: 'both' })],
      }),
    )

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('delta') // НЕ entry_signal/limit_entry/market_entry
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.symbol).toBe('SOLUSDT')
    expect(intent.ops).toEqual([{ op: 'tp_hit', index: 1 }])
  })

  it('noise -> route noise, intents=[]', () => {
    const result = normalizeAiOutput(output({ message_type: 'noise', actions: [] }))
    expect(result.route).toBe('noise')
    expect(result.intents).toEqual([])
  })

  it('commentary -> route noise, intents=[] (даже если модель что-то извлекла)', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'commentary',
        actions: [action({ type: 'tp_hit', symbol: 'BTCUSDT' })],
      }),
    )
    expect(result.route).toBe('noise')
    expect(result.intents).toEqual([])
  })

  it('несколько actions одного символа схлопываются в ОДИН delta-intent с несколькими ops', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'management_multi',
        actions: [
          action({ type: 'tp_hit', symbol: 'BTCUSDT', tp_index: 2 }),
          action({
            type: 'close',
            symbol: 'BTCUSDT',
            close_amount: { mode: 'fraction', value: 0.75 },
          }),
          action({
            type: 'modify_sl',
            symbol: 'BTCUSDT',
            stop_loss: { mode: 'marker', marker: 'entry_price' },
          }),
        ],
      }),
    )

    expect(result.route).toBe('execute')
    expect(result.intents).toHaveLength(1)
    const intent = result.intents[0]!
    expect(intent.kind).toBe('delta')
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([
      { op: 'tp_hit', index: 2 },
      { op: 'partial_close', fraction: 0.75 },
      { op: 'sl_breakeven' },
    ])
  })

  it('open range c числовым SL и TP-лесенкой -> entry_signal', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [
          action({
            type: 'open',
            symbol: 'LITUSDT',
            side: 'short',
            order_type: 'range',
            entry: { mode: 'range', low: 1.4735, high: 1.5273 },
            stop_loss: { mode: 'price', value: 1.7137 },
            take_profits: [{ value: 1.4428 }, { value: 1.3926 }, { value: 1.2777 }],
            risk_pct: 2,
          }),
        ],
      }),
    )

    expect(result.route).toBe('execute')
    expect(result.intents).toEqual([
      {
        kind: 'entry_signal',
        symbol: 'LITUSDT',
        side: 'short',
        entry: [1.4735, 1.5273],
        tps: [1.4428, 1.3926, 1.2777],
        sl: 1.7137,
        riskPct: 2,
      },
    ])
  })

  it('open с order_type=limit -> limit_entry', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [
          action({
            type: 'open',
            symbol: 'XRPUSDT',
            side: 'long',
            order_type: 'limit',
            entry: { mode: 'price', price: 1.118 },
          }),
        ],
      }),
    )

    expect(result.intents).toEqual([{ kind: 'limit_entry', symbol: 'XRPUSDT', side: 'long', price: 1.118 }])
  })

  it('open "с текущих" (entry.mode=marker current_price) -> market_entry без чисел', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [
          action({
            type: 'open',
            symbol: 'SOLUSDT',
            side: 'long',
            order_type: 'market',
            entry: { mode: 'marker', marker: 'current_price' },
          }),
        ],
      }),
    )

    expect(result.intents).toEqual([{ kind: 'market_entry', symbol: 'SOLUSDT', side: 'long' }])
  })

  it('add с ценой -> add intent с price', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'add_to_position',
        actions: [
          action({
            type: 'add',
            symbol: 'BTCUSDT',
            side: 'long',
            order_type: 'limit',
            entry: { mode: 'price', price: 60000 },
          }),
        ],
      }),
    )

    expect(result.intents).toEqual([{ kind: 'add', symbol: 'BTCUSDT', price: 60000 }])
  })

  it('modify_tp с числовыми целями -> tp_set', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'modify_tp',
        actions: [
          action({
            type: 'modify_tp',
            symbol: 'BTCUSDT',
            take_profits: [{ value: 63700 }, { value: 64600 }],
          }),
        ],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'tp_set', targets: [{ value: 63700 }, { value: 64600 }] }])
  })

  it('cancel_order -> delta cancel_pending', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'cancel_order',
        actions: [action({ type: 'cancel_order', symbol: 'SOLUSDT' })],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'cancel_pending' }])
  })

  it('sl_hit -> delta sl_hit', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'position_event',
        actions: [action({ type: 'sl_hit', symbol: 'ETHUSDT' })],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'sl_hit' }])
  })

  it('modify_sl mode=remove -> sl_cancel', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'modify_sl',
        actions: [action({ type: 'modify_sl', symbol: 'BTCUSDT', stop_loss: { mode: 'remove' } })],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'sl_cancel' }])
  })

  it('modify_sl mode=price value -> sl_set с конкретной ценой', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'modify_sl',
        actions: [action({ type: 'modify_sl', symbol: 'BTCUSDT', stop_loss: { mode: 'price', value: 64300 } })],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'sl_set', price: 64300 }])
  })

  it('close_amount mode=all -> close_remainder', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'close',
        actions: [action({ type: 'close', symbol: 'BTCUSDT', close_amount: { mode: 'all' } })],
      }),
    )

    const intent = result.intents[0]!
    if (intent.kind !== 'delta') throw new Error('unreachable')
    expect(intent.ops).toEqual([{ op: 'close_remainder' }])
  })

  it('неоднозначная комбинация (close_amount mode=units без маркера) -> route ai, needs_human', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'close',
        actions: [action({ type: 'close', symbol: 'BTCUSDT', close_amount: { mode: 'units', value: 3 } })],
      }),
    )

    expect(result.route).toBe('ai')
    expect(result.intents).toHaveLength(0)
  })

  it('ctx.isListed=false для резолвленного символа -> route skip, reason symbol_not_listed', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'modify_sl',
        actions: [action({ type: 'modify_sl', symbol: 'DELISTEDUSDT', stop_loss: { mode: 'remove' } })],
      }),
      { isListed: () => false },
    )

    expect(result.route).toBe('skip')
    expect(result.reason).toBe('symbol_not_listed')
  })

  it('image_used=true -> needsVision=true', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'position_event',
        image_used: true,
        actions: [action({ type: 'tp_hit', symbol: 'SOLUSDT', evidence_source: 'image' })],
      }),
    )
    expect(result.needsVision).toBe(true)
  })
})

// Раньше маппинг AI-выхода БЕЗУСЛОВНО выбрасывал stop_loss / take_profits / risk_pct во всех ветках
// кроме диапазонной: у типов market_entry/limit_entry этих полей просто не было. Из-за этого бот
// терял АВТОРСКИЙ стоп («беру соль с текущих, стоп 72») и вешал вместо него свой синтетический
// защитный — то есть менял замысел автора на свой.
describe('normalize-output — стоп/цели/риск автора не теряются на market/limit входах', () => {
  it('market_entry со стопом автора -> sl доезжает до intent', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [
          action({
            type: 'open',
            symbol: 'SOLUSDT',
            side: 'long',
            order_type: 'market',
            stop_loss: { mode: 'price', value: 72 },
            take_profits: [{ value: 80 }, { value: 83 }],
          }),
        ],
      }),
    )

    expect(result.intents).toEqual([
      { kind: 'market_entry', symbol: 'SOLUSDT', side: 'long', sl: 72, tps: [80, 83] },
    ])
  })

  it('limit_entry со стопом и риском автора -> поля доезжают', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [
          action({
            type: 'open',
            symbol: 'XRPUSDT',
            side: 'long',
            order_type: 'limit',
            entry: { mode: 'price', price: 1.1 },
            stop_loss: { mode: 'price', value: 1.0 },
            risk_pct: 2,
          }),
        ],
      }),
    )

    expect(result.intents).toEqual([
      { kind: 'limit_entry', symbol: 'XRPUSDT', side: 'long', price: 1.1, sl: 1.0, riskPct: 2 },
    ])
  })

  it('market_entry без стопа -> sl отсутствует (движок повесит свой защитный)', () => {
    const result = normalizeAiOutput(
      output({
        message_type: 'entry',
        actions: [action({ type: 'open', symbol: 'BTCUSDT', side: 'long', order_type: 'market' })],
      }),
    )

    expect(result.intents).toEqual([{ kind: 'market_entry', symbol: 'BTCUSDT', side: 'long' }])
  })
})
