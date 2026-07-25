// Нормализация AI-вывода extract_signal в ParsedIntent[] (research/ai-layer.md §3, задача 2 Ф2).
// Тот же контракт, что и у детерминированных адаптеров (channel-adapters.md §10, ch1.adapter.ts):
// вход — сырой вывод модели, выход — ParsedResult с ParsedIntent[]/DeltaOp[] из packages/shared —
// пайплайну (задача 4) НЕ важно, откуда взялся intent, детерминированно или от AI.
//
// ГЛАВНОЕ ПРАВИЛО (research §3/§10): LLM не считает арифметику — символьные маркеры
// (entry_price/one_unit/current_price) НЕ превращаются здесь в числа. Реальное число
// (avg_entry для sl_breakeven, qty одной леги для partial_close{unit:'one_unit'}, live-цена для
// current_price) подставляет код пайплайна из состояния сделки (задача 4) — эта функция только
// переносит маркер как есть в DeltaOp.

import type {
  CloseAmountSpec,
  ExtractedSide,
  ExtractSignalAction,
  ExtractSignalOutput,
  StopLossSpec,
  TakeProfitSpec,
} from './schema.js'
import type { DeltaOp, ParsedIntent, ParsedResult, Route, Side } from 'shared/domain.js'

/** Минимальный контекст резолюции — ядро решает про листинг, эта функция про Bybit не знает
 *  (тот же приём, что ParseContext.isListed у детерминированных адаптеров, channel-adapters.md §10).
 *  Опционален: чистые тесты нормализации могут не заботиться о листинге вовсе. */
export interface NormalizeAiOutputContext {
  isListed?: (symbol: string) => boolean
}

const NOISE_MESSAGE_TYPES = new Set<ExtractSignalOutput['message_type']>(['commentary', 'noise'])

/**
 * Маппит `extract_signal.actions[]` в `ParsedIntent[]` (research §3):
 * - `open` → `entry_signal`/`limit_entry`/`market_entry` по `order_type`/`entry.mode`.
 * - `add` → `add`.
 * - `close`/`modify_sl`/`modify_tp`/`cancel_order`/`tp_hit`/`sl_hit` — все ОДНОГО символа
 *   схлопываются в ОДИН `delta`-intent с несколькими `ops` (тот же приём, что R2 MULTI_MGMT
 *   ch1.adapter.ts: "один action на (символ,интент)", несколько интентов одного символа = один
 *   delta с массивом ops), а не по одному delta-intent на action — иначе пайплайн (задача 4)
 *   считал бы actionIndex на КАЖДЫЙ элементарный op, что рассогласовало бы orderLinkId-нумерацию
 *   с остальными адаптерами.
 *
 * `route`: `execute`, если ВСЕ actions резолвятся (ни одного `symbol==='UNKNOWN'`,
 * `needs_human===false`, ни одной семантически неоднозначной комбинации полей) И (если ctx.isListed
 * передан) все резолвленные символы торгуются; иначе `ai` (тот же Route, что и Ф1 "нужен
 * человек/AI" — reconciler.ts уже мапит его в outcome `needs_review`, второй раз изобретать
 * значение Route не нужно). `commentary`/`noise` → `noise`, `intents=[]` (сообщение — не сигнал).
 */
export function normalizeAiOutput(output: ExtractSignalOutput, ctx: NormalizeAiOutputContext = {}): ParsedResult {
  if (NOISE_MESSAGE_TYPES.has(output.message_type)) {
    return { route: 'noise', confidence: output.confidence, intents: [] }
  }

  const isListed = ctx.isListed ?? (() => true)

  const intents: ParsedIntent[] = []
  // Индекс delta-intent'а в `intents` по символу (null — символ не резолвлен) — группировка
  // нескольких actions одного символа в ОДИН delta-intent (см. JSDoc выше).
  const deltaIndexBySymbol = new Map<string | null, number>()

  let anyUnknownSymbol = false
  let anyUnresolvedMapping = false
  let anyNotListed = false

  for (const action of output.actions) {
    if (action.symbol === 'UNKNOWN') anyUnknownSymbol = true

    if (action.type === 'open' || action.type === 'add') {
      if (action.symbol !== 'UNKNOWN' && !isListed(action.symbol)) anyNotListed = true
      const mapped = action.type === 'open' ? mapOpenAction(action) : mapAddAction(action)
      if (mapped === null) {
        anyUnresolvedMapping = true
        continue
      }
      if (action.symbol === 'UNKNOWN') continue // символ не резолвлен — intent строить не из чего
      intents.push(mapped)
      continue
    }

    // Delta-производящие типы: close/modify_sl/modify_tp/cancel_order/tp_hit/sl_hit.
    const op = mapActionToDeltaOp(action)
    if (op === null) {
      anyUnresolvedMapping = true
      continue
    }
    if (action.symbol !== 'UNKNOWN' && !isListed(action.symbol)) anyNotListed = true

    const symbolKey = action.symbol === 'UNKNOWN' ? null : action.symbol
    const existingIndex = deltaIndexBySymbol.get(symbolKey)
    if (existingIndex !== undefined) {
      const existing = intents[existingIndex]
      // existing гарантированно delta — только delta-группы кладутся в deltaIndexBySymbol.
      if (existing !== undefined && existing.kind === 'delta') existing.ops.push(op)
    } else {
      deltaIndexBySymbol.set(symbolKey, intents.length)
      intents.push({ kind: 'delta', symbol: symbolKey, ops: [op] })
    }
  }

  const route = resolveRoute({
    needsHuman: output.needs_human,
    anyUnknownSymbol,
    anyUnresolvedMapping,
    anyNotListed,
  })

  const result: ParsedResult = { route, confidence: output.confidence, intents }
  const reason = resolveReason({ route, anyUnknownSymbol, needsHuman: output.needs_human, anyNotListed })
  if (reason !== undefined) result.reason = reason
  if (output.image_used) result.needsVision = true
  return result
}

interface RouteInputs {
  needsHuman: boolean
  anyUnknownSymbol: boolean
  anyUnresolvedMapping: boolean
  anyNotListed: boolean
}

/** execute, только если ВСЁ резолвилось однозначно; символ резолвлен, но не листингован — skip
 *  (та же семантика, что ch1.adapter.ts: не нужен человек, просто нельзя торговать); иначе ai
 *  (needs_review — двусмысленность требует внимания человека, research §11 "лучше пропустить
 *  исполнение, чем исполнить неверно"). */
function resolveRoute(inputs: RouteInputs): Route {
  if (inputs.needsHuman || inputs.anyUnknownSymbol || inputs.anyUnresolvedMapping) return 'ai'
  if (inputs.anyNotListed) return 'skip'
  return 'execute'
}

function resolveReason(inputs: {
  route: Route
  anyUnknownSymbol: boolean
  needsHuman: boolean
  anyNotListed: boolean
}): string | undefined {
  if (inputs.route === 'ai') {
    if (inputs.anyUnknownSymbol) return 'symbol_unknown_needs_vision'
    if (inputs.needsHuman) return 'needs_human'
    return 'ai_unresolved_marker'
  }
  if (inputs.route === 'skip' && inputs.anyNotListed) return 'symbol_not_listed'
  return undefined
}

// ---------------------------------------------------------------------------
// open -> entry_signal | limit_entry | market_entry
// ---------------------------------------------------------------------------

function toSide(side: ExtractedSide): Side | null {
  return side === 'unknown' ? null : side
}

/** null — action не резолвился в валидный intent (недостаточно числовых полей/сторона неясна). */
function mapOpenAction(action: ExtractSignalAction): ParsedIntent | null {
  const side = toSide(action.side)
  if (side === null) return null
  if (action.symbol === 'UNKNOWN') return null // route уже помечен anyUnknownSymbol выше

  const orderType = action.order_type ?? 'na'

  if (orderType === 'range') {
    const low = action.entry?.low
    const high = action.entry?.high
    const sl = action.stop_loss
    const slValue = sl !== undefined && sl.mode === 'price' ? (sl.value ?? null) : null
    if (low == null || high == null || slValue === null) return null

    const tps = (action.take_profits ?? [])
      .map((tp) => tp.value)
      .filter((v): v is number => v !== undefined && v !== null)

    const riskPct = action.risk_pct
    return {
      kind: 'entry_signal',
      symbol: action.symbol,
      side,
      entry: [low, high],
      tps,
      sl: slValue,
      ...(riskPct !== undefined && riskPct !== null ? { riskPct } : {}),
    }
  }

  // Стоп/цели/риск, если автор их дал. Раньше эти поля тут ВЫБРАСЫВАЛИСЬ: у типов limit_entry/
  // market_entry их просто не было, и авторский стоп («беру соль с текущих, стоп 72») терялся —
  // бот подставлял вместо него свой синтетический защитный. Теперь автор всегда приоритетнее.
  const authorSl = action.stop_loss !== undefined && action.stop_loss.mode === 'price' ? (action.stop_loss.value ?? null) : null
  const authorTps = (action.take_profits ?? []).map((tp) => tp.value).filter((v): v is number => v !== undefined && v !== null)
  const authorRisk = action.risk_pct
  const optional = {
    ...(authorSl !== null ? { sl: authorSl } : {}),
    ...(authorTps.length > 0 ? { tps: authorTps } : {}),
    ...(authorRisk !== undefined && authorRisk !== null ? { riskPct: authorRisk } : {}),
  }

  if (orderType === 'limit') {
    const price = action.entry?.mode === 'price' ? (action.entry.price ?? null) : null
    if (price === null) return null
    return { kind: 'limit_entry', symbol: action.symbol, side, price, ...optional }
  }

  // 'market' или 'na' (в т.ч. entry.mode='marker'/current_price, "с текущих") — безопасный
  // дефолт: market_entry не требует ни одного числа (research §2 C: "Sol long с текущих").
  return { kind: 'market_entry', symbol: action.symbol, side, ...optional }
}

// ---------------------------------------------------------------------------
// add -> add (всегда резолвится — price опционален в домене)
// ---------------------------------------------------------------------------

function mapAddAction(action: ExtractSignalAction): ParsedIntent | null {
  if (action.symbol === 'UNKNOWN') return null

  const price = action.entry?.mode === 'price' ? (action.entry.price ?? undefined) : undefined
  return { kind: 'add', symbol: action.symbol, ...(price !== undefined ? { price } : {}) }
}

// ---------------------------------------------------------------------------
// close/modify_sl/modify_tp/cancel_order/tp_hit/sl_hit -> DeltaOp
// ---------------------------------------------------------------------------

function mapActionToDeltaOp(action: ExtractSignalAction): DeltaOp | null {
  switch (action.type) {
    case 'close':
      return mapCloseAmount(action.close_amount)
    case 'modify_sl':
      return mapStopLoss(action.stop_loss)
    case 'modify_tp':
      return mapTakeProfits(action.take_profits)
    case 'cancel_order':
      return { op: 'cancel_pending' }
    case 'tp_hit':
      return action.tp_index !== undefined && action.tp_index !== null
        ? { op: 'tp_hit', index: action.tp_index }
        : { op: 'tp_hit' }
    case 'sl_hit':
      return { op: 'sl_hit' }
    case 'open':
    case 'add':
      return null // сюда не попасть — вызывающий код отфильтровывает open/add раньше
  }
}

/** close_amount → DeltaOp (research §3): fraction/all/units(one_unit) — единственные
 *  однозначно резолвящиеся комбинации; остальное (units без маркера, marker без one_unit, na) —
 *  null (needs_human, «лучше пропустить, чем исполнить неверно», research §11). */
function mapCloseAmount(ca: CloseAmountSpec | undefined): DeltaOp | null {
  if (ca === undefined) return null

  switch (ca.mode) {
    case 'all':
      return { op: 'close_remainder' }
    case 'fraction': {
      if (ca.value === undefined || ca.value === null) return null
      const basis = ca.basis !== undefined && ca.basis !== 'unknown' ? ca.basis : undefined
      return { op: 'partial_close', fraction: ca.value, ...(basis !== undefined ? { basis } : {}) }
    }
    case 'units':
    case 'marker':
      // «Скинул один объём»/«закрыл один объём» (research §3) — единственная однозначная units-
      // комбинация; числовой units без маркера НЕ поддержан здесь (нет надёжной семантики «какая
      // единица» без выдумывания) — needs_human.
      return ca.marker === 'one_unit' ? { op: 'partial_close', unit: 'one_unit' } : null
    case 'na':
      return null
  }
}

/** stop_loss → DeltaOp (research §3): marker=entry_price → sl_breakeven БЕЗ числа (безубыток —
 *  средняя цена входа, её знает только состояние сделки, не LLM); remove → sl_cancel; price →
 *  sl_set с конкретным числом. */
function mapStopLoss(sl: StopLossSpec | undefined): DeltaOp | null {
  if (sl === undefined) return null

  switch (sl.mode) {
    case 'remove':
      return { op: 'sl_cancel' }
    case 'marker':
      return sl.marker === 'entry_price' ? { op: 'sl_breakeven' } : null
    case 'price':
      return sl.value !== undefined && sl.value !== null ? { op: 'sl_set', price: sl.value } : null
    case 'na':
      return null
  }
}

/** take_profits[] → tp_set (research §3, "Следующие цели 72.7, 74"): каждая цель — число ИЛИ
 *  символьный маркер current_price (НЕ переводим в число здесь же). */
function mapTakeProfits(tps: TakeProfitSpec[] | undefined): DeltaOp | null {
  if (tps === undefined || tps.length === 0) return null

  const targets = tps
    .map((tp) => {
      if (tp.marker === 'current_price') return { marker: 'current_price' as const }
      if (tp.value !== undefined && tp.value !== null) return { value: tp.value }
      return null
    })
    .filter((t): t is { value: number } | { marker: 'current_price' } => t !== null)

  if (targets.length === 0) return null
  return { op: 'tp_set', targets }
}
