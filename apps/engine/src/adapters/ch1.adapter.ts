import { normalize } from '../normalize.js'
import { extractSide } from '../symbol-resolver.js'
import { parseNumbers, toNum } from 'shared/numbers.js'
import type { DeltaOp, ParseContext, ParsedIntent, ParsedResult } from 'shared/domain.js'

/**
 * Адаптер канала CH1 (2088626562) — регулярный формат сигналов
 * (docs/superpowers/research/channel-adapters.md §1, правила R1–R5).
 *
 * Порядок применения — первый матч выигрывает:
 *   R1 (entry_signal) → R2 (multi_mgmt) → R5-шумовые-ключевики → R3 (delta reply)
 *   → R4 (delta standalone) → фолбэк NOISE.
 *
 * ПОЧЕМУ шумовой гейт R5 (обзор/анонс/zoom/...) стоит РАНЬШЕ R3/R4, хотя в
 * исследовании перечислен последним по номеру: обзоры (`#BTC обзор`) часто
 * содержат встроенные упоминания `#TICKER + action` с КОНКРЕТНЫМ (не hold)
 * действием — напр. msg 2799 "#BTC обзор ... Остаток по #LIT ушел в б/у"
 * (sl_be, не hold). Если бы R3/R4 матчились раньше noise-гейта, символ дельты
 * взялся бы от ПЕРВОГО хэштега в тексте (#BTC), а не от #LIT — абсурдная
 * дельта по биткоину. research §5 явно требует: «если сообщение — обзор,
 * встроенные #TICKER+action не исполняются как ордера». Проверять "#BTC
 * обзор" нужно раньше R3/R4, иначе тест «любое #BTC обзор → noise» падает.
 */
export function parseCh1(ctx: ParseContext): ParsedResult {
  const text = ctx.message.text ?? ''

  return (
    tryEntrySignal(text, ctx) ??
    tryMultiMgmt(text, ctx) ??
    tryNoiseKeywords(text) ??
    tryDeltaReply(text, ctx) ??
    tryDeltaStandalone(text, ctx) ??
    fallbackNoise()
  )
}

// ---------------------------------------------------------------------------
// Action-лексикон CH1 (research §1, таблица) — регэкспы дословно.
// Имена узлов DeltaOp отличаются от коротких имён из таблицы (fix→partial_close,
// sl_be→sl_breakeven, close→close_remainder) — это имена вариантов домена
// packages/shared/src/domain.ts (research §10), таблица писалась короче для читаемости.
// ---------------------------------------------------------------------------

type LexOp = 'tp_hit' | 'partial_close' | 'sl_breakeven' | 'sl_hit' | 'close_remainder' | 'hold'

const ACTION_LEXICON: ReadonlyArray<{ readonly op: LexOp; readonly re: RegExp }> = [
  // research §1 таблица пишет "второй тейк" явно, но не "вторая цель" — асимметрия
  // транскрипции (первая форма покрывает и цель, и тейк, вторая — только тейк).
  // На дампе встречается "#AERO - вторая цель, ..." (msg 2816) — симметрично
  // расширяем до втор(ая|ой)\s+(цель|тейк), иначе делта теряется (падает в noise).
  { op: 'tp_hit', re: /перв(ая|ый)\s+(цель|тейк)|втор(ая|ой)\s+(цель|тейк)|цель\s+(взята|есть)/ },
  { op: 'partial_close', re: /зафиксировал\s*\d+%|фиксирую|закрыл\s*\d+%/ }, // "fix"
  { op: 'sl_breakeven', re: /стоп\s+(в\s+б\/у|перевел|перевожу)|ушел в б\/у/ }, // "sl_be"
  { op: 'sl_hit', re: /выбило по стоп|по стоп-лоссу|закрыто по стоп/ },
  {
    op: 'close_remainder', // "close"
    re: /закрыва(ю|ем)|закрыть|остаток\s+(закрыва|зафиксир|ушел)|зафиксировал (позици|остаток|полностью)|прикрываю позици/,
  },
  { op: 'hold', re: /продолжаю удерживать/ }, // no-op — никогда не исполняется как ордер
]

function toDeltaOp(op: LexOp): DeltaOp {
  switch (op) {
    case 'tp_hit':
      return { op: 'tp_hit' }
    case 'partial_close':
      return { op: 'partial_close' }
    case 'sl_breakeven':
      return { op: 'sl_breakeven' }
    case 'sl_hit':
      return { op: 'sl_hit' }
    case 'close_remainder':
      return { op: 'close_remainder' }
    case 'hold':
      return { op: 'hold' }
  }
}

/** Прогоняет фрагмент текста (уже нормализованный внутри) через весь action-лексикон. */
function extractOps(segment: string): DeltaOp[] {
  const normalized = normalize(segment)
  const ops: DeltaOp[] = []
  for (const { op, re } of ACTION_LEXICON) {
    if (re.test(normalized)) ops.push(toDeltaOp(op))
  }
  return ops
}

/** Все хэштеги `#TICKER` в порядке появления (без резолва алиасов/листинга). */
function allHashtags(text: string): string[] {
  return [...text.matchAll(/#([A-Za-z0-9]+)/g)].map((m) => m[1]!) // группа обязательная — иначе паттерн не матчит
}

function firstHashtag(text: string): string | null {
  return allHashtags(text)[0] ?? null
}

function firstNonBtcHashtag(text: string): string | null {
  return allHashtags(text).find((t) => t.toUpperCase() !== 'BTC') ?? null
}

// ---------------------------------------------------------------------------
// R1. ENTRY SIGNAL
// ---------------------------------------------------------------------------

const ENTRY_HASHTAG_RE = /#([a-zA-Z0-9]+)\/usdt/i
const ENTRY_GATE_RE = /диапазон\s+входа/i
const ENTRY_RANGE_RE = /диапазон\s+входа:?\s*([\d.,\s]+?)\s*[-–—]\s*([\d.,\s]+?)\s*\$/i
const TP_LINE_RE = /tp:?\s*([^\n]+)/i
const SL_RE = /sl:?\s*([\d.,]+)\s*\$/i
const RISK_RE = /риск:?\s*([\d.,]+)\s*%/i

function tryEntrySignal(text: string, ctx: ParseContext): ParsedResult | null {
  const hashtagMatch = ENTRY_HASHTAG_RE.exec(text)
  if (!hashtagMatch || !ENTRY_GATE_RE.test(text)) return null

  // resolveSymbol на минимальном фрагменте (сам хэштег из сигнала), а НЕ на всём
  // тексте: символьный резолвер сперва сканирует ВСЕ слова текста на кирилл.
  // алиасы (BTC/ETH/SOL/XRP/DOGE) и только потом хэштег — случайное упоминание
  // "биткоин" в описательной части сигнала иначе перебило бы реальный тикер сделки.
  const symbol = ctx.resolveSymbol(hashtagMatch[0]!)
  const side = extractSide(text)

  const entryMatch = ENTRY_RANGE_RE.exec(text)
  const entryLo = entryMatch?.[1]
  const entryHi = entryMatch?.[2]
  const entry: [number, number] | null =
    entryLo !== undefined && entryHi !== undefined ? [toNum(entryLo), toNum(entryHi)] : null

  const slMatch = SL_RE.exec(text)
  const slRaw = slMatch?.[1]
  const sl = slRaw !== undefined ? toNum(slRaw) : null

  const tpLineMatch = TP_LINE_RE.exec(text)
  const tpLine = tpLineMatch?.[1]
  const tps = tpLine !== undefined ? parseNumbers(tpLine) : []

  const riskMatch = RISK_RE.exec(text)
  const riskRaw = riskMatch?.[1]
  const riskPct = riskRaw !== undefined ? toNum(riskRaw) : undefined

  // conf = 0.6 + 0.1·|{sym,dir,entry,SL}| (research §1 R1)
  const presentCount = [symbol, side, entry, sl].filter((v) => v !== null).length
  const confidence = Math.min(1, 0.6 + 0.1 * presentCount)

  if (sl === null) {
    return { route: 'skip', confidence, intents: [], reason: 'no_SL' }
  }
  if (symbol === null) {
    return { route: 'skip', confidence, intents: [], reason: 'symbol_unknown' }
  }
  if (!ctx.isListed(symbol)) {
    return { route: 'skip', confidence, intents: [], reason: 'symbol_not_listed' }
  }
  if (side === null || entry === null) {
    return { route: 'skip', confidence, intents: [], reason: 'incomplete_signal' }
  }

  const intent: ParsedIntent = {
    kind: 'entry_signal',
    symbol,
    side,
    entry,
    tps,
    sl,
    ...(riskPct !== undefined ? { riskPct } : {}),
  }
  return { route: 'execute', confidence, intents: [intent] }
}

// ---------------------------------------------------------------------------
// R2. MULTI_MGMT
// ---------------------------------------------------------------------------

const MGMT_GATE_RE = /менеджмент/i
const MGMT_LINE_RE = /#([A-Za-z0-9]+)\s*[-—:]\s*([^\n#]+)/g

function tryMultiMgmt(text: string, ctx: ParseContext): ParsedResult | null {
  if (!MGMT_GATE_RE.test(text)) return null

  const intents: ParsedIntent[] = []
  for (const m of text.matchAll(MGMT_LINE_RE)) {
    const ticker = m[1]! // обязательная группа — иначе паттерн не матчит
    const actionText = m[2]!
    const symbol = ctx.resolveSymbol(`#${ticker}`)
    if (symbol === null || !ctx.isListed(symbol)) continue // не резолвится/не торгуется — пропускаем эту дельту
    const ops = extractOps(actionText)
    if (ops.length === 0) continue
    intents.push({ kind: 'delta', symbol, ops })
  }

  // гейт "Менеджмент" сработал, но ни одной валидной дельты не вытащили — не наш случай
  if (intents.length === 0) return null
  return { route: 'execute', confidence: 0.85, intents }
}

// ---------------------------------------------------------------------------
// R5. NOISE (ключевые слова обзора/анонсов) — проверяется раньше R3/R4, см.
// комментарий в parseCh1() выше.
// ---------------------------------------------------------------------------

const NOISE_KEYWORDS_RE = /#btc\s*обзор|анонс|созвон|zoom|копитрейдинг|okx|реф/i

function tryNoiseKeywords(text: string): ParsedResult | null {
  if (!NOISE_KEYWORDS_RE.test(text)) return null
  return { route: 'noise', confidence: 0.1, intents: [] }
}

// ---------------------------------------------------------------------------
// R3. DELTA (reply)
// ---------------------------------------------------------------------------

function tryDeltaReply(text: string, ctx: ParseContext): ParsedResult | null {
  if (ctx.message.replyToMsgId === null) return null

  const ticker = firstNonBtcHashtag(text)
  if (ticker === null) return null

  const ops = extractOps(text)
  if (ops.length === 0) return null

  const symbol = ctx.resolveSymbol(`#${ticker}`)
  if (symbol === null) return null // тикер есть, но не резолвится — отдаём другим правилам/фолбэку
  if (!ctx.isListed(symbol)) {
    return { route: 'skip', confidence: 0.9, intents: [], reason: 'symbol_not_listed' }
  }

  // reply даёт линковку к сделке, но она избыточна для CH1 — символ сам
  // определяет позицию (изоляция «один символ — один канал», research §1 R3).
  return { route: 'execute', confidence: 0.9, intents: [{ kind: 'delta', symbol, ops }] }
}

// ---------------------------------------------------------------------------
// R4. DELTA_STANDALONE
// ---------------------------------------------------------------------------

function tryDeltaStandalone(text: string, ctx: ParseContext): ParsedResult | null {
  if (ctx.message.replyToMsgId !== null) return null

  const ticker = firstHashtag(text)
  if (ticker === null) return null

  const ops = extractOps(text)
  if (ops.length === 0) return null

  // конкретный action → DET, иначе (только hold) → NOISE (research §1 R4)
  const isHoldOnly = ops.length === 1 && ops[0]?.op === 'hold'
  if (isHoldOnly) {
    return { route: 'noise', confidence: 0.2, intents: [] }
  }

  const symbol = ctx.resolveSymbol(`#${ticker}`)
  if (symbol === null) return null
  if (!ctx.isListed(symbol)) {
    return { route: 'skip', confidence: 0.8, intents: [], reason: 'symbol_not_listed' }
  }
  return { route: 'execute', confidence: 0.8, intents: [{ kind: 'delta', symbol, ops }] }
}

// ---------------------------------------------------------------------------
// Фолбэк — ни одно правило не сработало (пустые/медиа-только сообщения и т.п.)
// ---------------------------------------------------------------------------

function fallbackNoise(): ParsedResult {
  return { route: 'noise', confidence: 0, intents: [] }
}
