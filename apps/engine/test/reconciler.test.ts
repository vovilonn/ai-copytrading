import { describe, it, expect } from 'vitest'
import type { ParsedIntent, ParsedResult } from 'shared/domain.js'
import { AI_CONFIDENCE_GATE, reconcile, type ReconcileContext } from '../src/reconciler.js'

// reconcile() (задача 4 Ф2, research/ai-layer.md §8/§11/§12, .superpowers/sdd/task-4-brief.md) —
// чистые тесты слияния детерминированного и AI-разбора, без сети/БД.

const ctx: ReconcileContext = { channelId: 1962583820 }

function det(overrides: Partial<ParsedResult> & Pick<ParsedResult, 'route' | 'intents'>): ParsedResult {
  return { confidence: 1, ...overrides }
}

function ai(overrides: Partial<ParsedResult> & Pick<ParsedResult, 'route' | 'intents'>): ParsedResult {
  return { confidence: 0.9, ...overrides }
}

const btcLongEntry: ParsedIntent = { kind: 'entry_signal', symbol: 'BTCUSDT', side: 'long', entry: 60000, tps: [61000], sl: 59000 }
const ethLongEntry: ParsedIntent = { kind: 'entry_signal', symbol: 'ETHUSDT', side: 'long', entry: 3000, tps: [3100], sl: 2900 }
const btcShortEntry: ParsedIntent = { kind: 'entry_signal', symbol: 'BTCUSDT', side: 'short', entry: 60000, tps: [59000], sl: 61000 }

describe('reconcile — Ф1-путь (route!=="ai", ai всегда null)', () => {
  it('route noise -> outcome noise, method null', () => {
    const decision = reconcile(det({ route: 'noise', intents: [] }), null, ctx)
    expect(decision).toEqual({ outcome: 'noise', method: null, decided: [] })
  })

  it('route skip -> outcome skipped, method auto, reason парсера', () => {
    const decision = reconcile(det({ route: 'skip', intents: [], reason: 'symbol_not_listed' }), null, ctx)
    expect(decision.outcome).toBe('skipped')
    expect(decision.method).toBe('auto')
    expect(decision.reason).toBe('symbol_not_listed')
  })

  it('route execute, ai=null (CH1 никогда не зовёт AI) -> executing, method auto, intents детерминированного', () => {
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), null, ctx)
    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('auto')
    expect(decision.decided).toEqual([{ actionIndex: 0, intent: btcLongEntry }])
  })
})

describe('reconcile — §12 rule 1: шаблон совпал ∧ AI согласен -> auto, числа детерминированного', () => {
  it('AI подтвердил тот же (symbol,side,type) с ДРУГИМИ числами -> берём числа ДЕТЕРМИНИРОВАННОГО', () => {
    const aiEntry: ParsedIntent = { kind: 'entry_signal', symbol: 'BTCUSDT', side: 'long', entry: 60123, tps: [61500], sl: 58900 }
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), ai({ route: 'execute', intents: [aiEntry] }), ctx)

    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('auto')
    expect(decision.decided).toEqual([{ actionIndex: 0, intent: btcLongEntry }]) // ИМЕННО det-intent (числа det), не ai
  })

  it('несколько det-intent (management_multi) — AI согласен по каждому -> auto, все из det', () => {
    const aiIntents: ParsedIntent[] = [
      { kind: 'entry_signal', symbol: 'BTCUSDT', side: 'long', entry: 1, tps: [], sl: 1 },
      { kind: 'entry_signal', symbol: 'ETHUSDT', side: 'long', entry: 1, tps: [], sl: 1 },
    ]
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry, ethLongEntry] }), ai({ route: 'execute', intents: aiIntents }), ctx)
    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('auto')
    expect(decision.decided).toEqual([
      { actionIndex: 0, intent: btcLongEntry },
      { actionIndex: 1, intent: ethLongEntry },
    ])
  })
})

describe('reconcile — §12 rule 3: шаблон совпал, AI НЕ согласен -> needs_review parser_disagreement', () => {
  it('AI дал ДРУГОЙ symbol -> needs_review, method review, reason parser_disagreement, 0 decided', () => {
    const aiEntry: ParsedIntent = { kind: 'entry_signal', symbol: 'ETHUSDT', side: 'long', entry: 3000, tps: [3100], sl: 2900 }
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), ai({ route: 'execute', intents: [aiEntry] }), ctx)

    expect(decision.outcome).toBe('needs_review')
    expect(decision.method).toBe('review')
    expect(decision.reason).toBe('parser_disagreement')
    expect(decision.decided).toEqual([])
  })

  it('AI дал тот же символ, но ДРУГУЮ side (short vs long) -> needs_review parser_disagreement', () => {
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), ai({ route: 'execute', intents: [btcShortEntry] }), ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.reason).toBe('parser_disagreement')
  })

  it('AI поднял needs_human при совпавшем шаблоне -> needs_review parser_disagreement', () => {
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), ai({ route: 'ai', intents: [], reason: 'needs_human' }), ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.method).toBe('review')
    expect(decision.reason).toBe('parser_disagreement')
  })

  it('AI посчитал сообщение шумом (route noise) при совпавшем шаблоне -> конфликт (не молчаливое доверие AI)', () => {
    const decision = reconcile(det({ route: 'execute', intents: [btcLongEntry] }), ai({ route: 'noise', intents: [] }), ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.reason).toBe('parser_disagreement')
  })
})

describe('reconcile — §12 rule 4: symbol=UNKNOWN от AI, но шаблон дал символ -> берём шаблон', () => {
  it('ai.route=ai reason=symbol_unknown_needs_vision -> executing auto, decided из ДЕТЕРМИНИРОВАННОГО', () => {
    const decision = reconcile(
      det({ route: 'execute', intents: [btcLongEntry] }),
      ai({ route: 'ai', intents: [], reason: 'symbol_unknown_needs_vision' }),
      ctx,
    )
    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('auto')
    expect(decision.decided).toEqual([{ actionIndex: 0, intent: btcLongEntry }])
  })
})

describe('reconcile — §12 rule 2: шаблон НЕ совпал -> всё из AI, method ai', () => {
  it('det.route=ai (терсный/free-form), ai резолвит уверенно -> executing, method ai, decided из AI', () => {
    const aiIntent: ParsedIntent = { kind: 'delta', symbol: 'BTCUSDT', ops: [{ op: 'partial_close', fraction: 0.5, basis: 'original' }] }
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'execute', intents: [aiIntent], confidence: 0.92 }), ctx)

    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('ai')
    expect(decision.decided).toEqual([{ actionIndex: 0, intent: aiIntent }])
  })

  it('символ-less дельта: AI резолвил символ из картинки/reply/позиций -> decided несёт ЭТОТ символ', () => {
    const aiIntent: ParsedIntent = { kind: 'delta', symbol: 'BTCUSDT', ops: [{ op: 'sl_breakeven' }] }
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'execute', intents: [aiIntent], confidence: 0.95 }), ctx)

    expect(decision.outcome).toBe('executing')
    expect(decision.method).toBe('ai')
    const only = decision.decided[0]!
    expect(only.intent.kind).toBe('delta')
    if (only.intent.kind !== 'delta') throw new Error('unreachable')
    expect(only.intent.symbol).toBe('BTCUSDT')
  })

  it('ai.route=noise (AI распознал шум) -> outcome noise, method null', () => {
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'noise', intents: [] }), ctx)
    expect(decision).toEqual({ outcome: 'noise', method: null, decided: [] })
  })

  it('ai.route=skip (символ резолвлен, но не листингован) -> skipped, method ai, reason ai', () => {
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'skip', intents: [], reason: 'symbol_not_listed' }), ctx)
    expect(decision.outcome).toBe('skipped')
    expect(decision.method).toBe('ai')
    expect(decision.reason).toBe('symbol_not_listed')
  })

  it('ai.route=ai (needs_human) -> needs_review, method review, reason needs_human', () => {
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'ai', intents: [], reason: 'needs_human' }), ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.method).toBe('review')
    expect(decision.reason).toBe('needs_human')
  })

  it('ai.route=ai (symbol_unknown_needs_vision, БЕЗ шаблонной подсказки) -> needs_review (нечему довериться)', () => {
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'ai', intents: [], reason: 'symbol_unknown_needs_vision' }), ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.reason).toBe('symbol_unknown_needs_vision')
  })
})

describe('reconcile — гейт уверенности (research §8/§11)', () => {
  it('confidence=0.5 (<0.7) -> needs_review, method review, reason low_confidence, 0 decided', () => {
    const aiIntent: ParsedIntent = { kind: 'delta', symbol: 'BTCUSDT', ops: [{ op: 'sl_hit' }] }
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'execute', intents: [aiIntent], confidence: 0.5 }), ctx)

    expect(decision.outcome).toBe('needs_review')
    expect(decision.method).toBe('review')
    expect(decision.reason).toBe('low_confidence')
    expect(decision.decided).toEqual([])
  })

  it(`confidence ровно на границе (${AI_CONFIDENCE_GATE}) -> ПРОХОДИТ гейт (executing)`, () => {
    const aiIntent: ParsedIntent = { kind: 'delta', symbol: 'BTCUSDT', ops: [{ op: 'sl_hit' }] }
    const decision = reconcile(det({ route: 'ai', intents: [] }), ai({ route: 'execute', intents: [aiIntent], confidence: AI_CONFIDENCE_GATE }), ctx)
    expect(decision.outcome).toBe('executing')
  })
})

describe('reconcile — деградация (AI недоступен): ai=null при route "ai"', () => {
  it('det.route=ai, ai=null -> needs_review, method review, reason ai_unavailable, 0 decided', () => {
    const decision = reconcile(det({ route: 'ai', intents: [] }), null, ctx)
    expect(decision.outcome).toBe('needs_review')
    expect(decision.method).toBe('review')
    expect(decision.reason).toBe('ai_unavailable')
    expect(decision.decided).toEqual([])
  })
})
