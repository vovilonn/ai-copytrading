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
    fallback(ctx)
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
    // «фиксируюсь по текущим полностью» (msg #DUSK) — это ВЕСЬ остаток, а не половина:
    // без этой ветки фраза падала в partial_close и закрывала 50% вместо 100%.
    //
    // Слово «остаток» и глагол фиксации разделяются другими словами: живой случай прода
    // 31.07.2026 — «#ARB – остаток ПОЗИЦИИ фиксирую по текущим» закрыл половину вместо всего,
    // потому что прежний шаблон требовал глагол СРАЗУ после «остаток». Разрешаем зазор в обе
    // стороны, но внутри одного предложения ([^.\n]) — иначе «зафиксировал 50%. Остаток тяну
    // дальше» склеилось бы в полное закрытие. Формы будущего времени («остаток закрою по 1.2»)
    // сюда намеренно не входят: это план, а не команда сейчас.
    //
    // «фиксирую ПОЗИЦИЮ» — тоже полный выход, и в НАСТОЯЩЕМ времени: живой случай 05.08.2026
    // («#INJ – фиксирую позицию около зоны входа») закрыл половину, потому что шаблон знал только
    // прошедшее «зафиксировал позицию». Слово «позици» обязано идти СРАЗУ за глаголом (допускается
    // «всю»): так «фиксирую 50% позиции» и «фиксирую половину позиции» остаются частичными —
    // между глаголом и «позици» там стоит доля.
    // ЗАПЯТАЯ — ГРАНИЦА СМЫСЛА, не только точка. Живой случай прода 13.08.2026:
    // «Зафиксировал 50% позиции, остаток продолжаю удерживать» — зазор между «зафиксировал» и
    // «остаток» перепрыгнул запятую и склеил ДВА разных предложения в «фиксирую остаток». Бот
    // закрыл всю позицию там, где автор закрыл половину, и остаток вышел в минус. Фраза, ради
    // которой зазор вводился («остаток ПОЗИЦИИ фиксирую по текущим»), запятой внутри не имеет.
    re: /закрыва(ю|ем)|закрыть|остат[а-я]*[^.,\n]{0,25}(закрыва(ю|ем)|закрыть|зафиксир[а-я]*|фиксир[а-я]*|снимаю|выхожу|ушел)|(зафиксир[а-я]*|фиксир[а-я]*)[^.,\n]{0,25}остат[а-я]*|(за)?фиксир[а-я]*\s+(всю\s+)?позици|зафиксировал (позици|остаток|полностью)|прикрываю позици|фиксир[а-я]*[^.,\n]{0,25}полностью|полностью[^.,\n]{0,25}фиксир[а-я]*/,
  },
  { op: 'hold', re: /продолжаю удерживать|остат[а-я]*\s+(продолжаю\s+)?(удержив|держ|оставля|тян)[а-я]*/ }, // no-op — никогда не исполняется как ордер
]

/**
 * «Остаток продолжаю удерживать», «остаток держу», «остаток оставляю в рынке» — про остаток здесь
 * сказано ПРЯМО ПРОТИВОПОЛОЖНОЕ закрытию. Отдельный гейт поверх лексикона: слово «остаток» само по
 * себе к нему притягивает (оно живёт в шаблоне close_remainder), и одной запятой-границы мало —
 * «остаток пока удерживаю» запятой не содержит вовсе.
 */
const REMAINDER_HELD_RE =
  /остат[а-я]*[^.\n]{0,30}(удержив|держ[уаи]|оставля|тян[ует]|не\s+трога)|(удержив|держ[уаи]|оставля|тян[ует])[^.\n]{0,30}остат[а-я]*/

/** Шаблон полного закрытия — им гасим partial_close на фразах вида «фиксируюсь полностью». */
const FULL_CLOSE_RE = ACTION_LEXICON.find((l) => l.op === 'close_remainder')!.re

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

/**
 * «Ничего пока НЕ фиксирую, держите крепко» — отрицание переворачивает смысл фразы. Голый
 * лексикон видел здесь «фиксирую» и порождал partial_close, т.е. закрывал половину позиции
 * ровно там, где автор просил не трогать её. Под отрицанием fix/close не порождаем вовсе —
 * пустой набор ops уводит сообщение в AI, который и разбирает такие формулировки.
 */
// \b и \w в JS определены по ASCII — на кириллице /\bне/ и /фиксиру\w*/ НЕ матчатся вовсе
// (именно поэтому первая версия гейта молча пропускала отрицание). Границу слева задаём
// lookbehind по кириллице, хвосты слов — явным классом [а-я] (normalize уже сделал ё→е).
const CLOSE_NEGATION_RE = /(?<![а-я])не\s+(?:буду\s+|планирую\s+|собираюсь\s+)?(?:фиксир[а-я]*|закрыв[а-я]*|закрыть)/

/**
 * Явная доля фиксации: «25% фиксирую», «зафиксировал 50%», «закрыл 30%». Без неё пайплайн
 * подставлял бы дефолтную половину — для «Пробит хай, 25% фиксирую» это вдвое больший объём.
 * Процент читаем только вплотную к глаголу фиксации: «профит 30%» долей закрытия не является.
 */
// Каноничная форма доли фиксации — глагол ПЕРЕД числом: «фиксирую 50%», «закрыл 30%».
const FRACTION_AFTER_RE = /(?:фиксир[а-я]*|зафиксировал[а-я]*|закрыл[а-я]*|фикс)\s*(\d{1,3})\s*%/
// Число ПЕРЕД глаголом: «50% фиксирую». Но НЕ процент прибыли: «+30% фиксирую 50%» — здесь «30» это
// профит (стоит после «+»), а доля закрытия — «50» справа от глагола. Поэтому (а) эту форму пробуем
// ТОЛЬКО когда формы «глагол→число» в тексте нет, и (б) отвергаем число, идущее сразу после «+».
const FRACTION_BEFORE_RE = /(?<![+\d])(\d{1,3})\s*%\s*(?:фиксир[а-я]*|зафиксировал[а-я]*|закрыл[а-я]*|фикс)/

function partialCloseOp(normalized: string): DeltaOp {
  const m = FRACTION_AFTER_RE.exec(normalized) ?? FRACTION_BEFORE_RE.exec(normalized)
  const pct = Number(m?.[1])
  // Доля вне (0;100) — мусор от опечатки, а не намерение: пусть долю определит AI.
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return { op: 'partial_close' }
  return { op: 'partial_close', fraction: pct / 100 }
}

/** Прогоняет фрагмент текста (уже нормализованный внутри) через весь action-лексикон. */
function extractOps(segment: string): DeltaOp[] {
  const normalized = normalize(segment)
  const negated = CLOSE_NEGATION_RE.test(normalized)
  const ops: DeltaOp[] = []
  for (const { op, re } of ACTION_LEXICON) {
    if (!re.test(normalized)) continue
    if (negated && (op === 'partial_close' || op === 'close_remainder')) continue
    // Остаток объявлен УДЕРЖИВАЕМЫМ — закрывать его нельзя, что бы ни намекал лексикон.
    if (op === 'close_remainder' && REMAINDER_HELD_RE.test(normalized)) continue
    // «фиксируюсь полностью» ловится обоими шаблонами — побеждает полное закрытие. Но если
    // полное закрытие отменено гейтом удержания остатка, доля обязана выжить: «зафиксировал 50%,
    // остаток удерживаю» — это ровно фиксация половины.
    if (op === 'partial_close' && FULL_CLOSE_RE.test(normalized) && !REMAINDER_HELD_RE.test(normalized)) continue
    ops.push(op === 'partial_close' ? partialCloseOp(normalized) : toDeltaOp(op))
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


/**
 * СЕГМЕНТЫ ПО СИМВОЛАМ: `#TICKER` и весь текст до СЛЕДУЮЩЕГО `#TICKER`.
 *
 * Одно сообщение сплошь и рядом ведёт НЕСКОЛЬКО позиций, и без слова «Менеджмент» в заголовке
 * (по нему работает R2). Живой случай прода 12.08.2026 — сообщение 2999:
 *
 *     Доброе утро, друзья ☀️
 *     #ZRO - фиксирую позицию по текущим в зоне входа. …
 *     #ETHFI - фиксирую позицию по текущим полностью. …
 *
 * Правила R3/R4 брали ПЕРВЫЙ хэштег и прогоняли лексикон по ВСЕМУ тексту: закрылся только ZRO,
 * а инструкция по ETHFI растворилась в его же ops. Позиция провисела сутки и закрылась в −8.70
 * вместо профита, которого хотел автор.
 */
function symbolSegments(text: string): Array<{ ticker: string; segment: string }> {
  const matches = [...text.matchAll(/#([A-Za-z0-9]+)/g)]
  return matches.map((m, i) => ({
    ticker: m[1]!, // группа обязательная — иначе паттерн не матчит
    segment: text.slice(m.index!, matches[i + 1]?.index ?? text.length),
  }))
}

/**
 * Строит дельты сообщения. Один символ — прежнее поведение (лексикон по всему тексту: действие
 * запросто стоит ДО хэштега, «фиксирую половину по #ARB»). Несколько — каждому символу только
 * СВОЙ сегмент, чужие инструкции к нему не приклеиваются.
 *
 * `null` — дельт нет вовсе (правило не наше). `{ escalate: true }` — символов несколько, действие
 * в тексте есть, но ни один сегмент его не содержит («Фиксирую по #ARB и #INJ»): приписать
 * действие одному из них значило бы угадать, а промолчать — потерять. Такое уходит в AI.
 */
type DeltaBuild = { intents: ParsedIntent[] } | { escalate: true } | { notListed: true } | null

function buildDeltaIntents(text: string, ctx: ParseContext, tickers: string[]): DeltaBuild {
  const segments = symbolSegments(text).filter((s) => tickers.includes(s.ticker))
  const resolved = segments
    .map((s) => ({ symbol: ctx.resolveSymbol(`#${s.ticker}`), segment: s.segment }))
    .filter((s): s is { symbol: string; segment: string } => s.symbol !== null)
  if (resolved.length === 0) return null

  const listed = resolved.filter((s) => ctx.isListed(s.symbol))
  if (listed.length === 0) return { notListed: true }

  const distinct = new Set(listed.map((s) => s.symbol))
  if (distinct.size === 1) {
    const ops = extractOps(text)
    if (ops.length === 0) return null
    return { intents: [{ kind: 'delta', symbol: listed[0]!.symbol, ops }] }
  }

  const intents: ParsedIntent[] = []
  const seen = new Set<string>()
  for (const { symbol, segment } of listed) {
    if (seen.has(symbol)) continue
    const ops = extractOps(segment)
    if (ops.length === 0) continue
    seen.add(symbol)
    intents.push({ kind: 'delta', symbol, ops })
  }
  if (intents.length > 0) return { intents }
  return extractOps(text).length > 0 ? { escalate: true } : null
}

// ---------------------------------------------------------------------------
// R1. ENTRY SIGNAL
// ---------------------------------------------------------------------------

const ENTRY_HASHTAG_RE = /#([a-zA-Z0-9]+)\/usdt/i
const ENTRY_GATE_RE = /диапазон\s+входа/i
const ENTRY_RANGE_RE = /диапазон\s+входа:?\s*([\d.,\s]+?)\s*[-–—]\s*([\d.,\s]+?)\s*\$/i
const TP_LINE_RE = /tp:?\s*([^\n]+)/i
// `\s` в классе символов (не только между `sl:` и числом, но и ВНУТРИ самого числа) — как у
// ENTRY_RANGE_RE выше: у крупных монет (BTC/ETH) стоп пишут с пробелом-разделителем тысяч
// ("SL: 61 500$", обычный или неразрывный U+00A0 пробел). Без `\s` в классе класс `[\d.,]+`
// останавливался на первом пробеле — совпадение схлопывалось до "61", число терялось, а
// сигнал ложно уходил в skip(no_SL). `toNum` (shared/numbers.ts) сам снимает пробелы-разделители
// при конвертации в число — здесь достаточно просто дать регэкспу их не отбрасывать при матче.
const SL_RE = /sl:?\s*([\d.,\s]+?)\s*\$/i
const RISK_RE = /риск:?\s*([\d.,\s]+?)\s*%/i

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

  // ── Regex понял, что это сигнал, но собрать его целиком не смог ────────────────────────────────
  //
  // Раньше такие сообщения уходили в skip и НЕ торговались: канал сменил формат стопа/тикера — и бот
  // молча переставал открывать сделки, а в UI это выглядело как обычный пропуск. Теперь любая
  // НЕУВЕРЕННОСТЬ шаблона отдаётся AI (route='ai'): он читает текст свободно, поэтому переживает
  // смену формата, понимает «стоп за 72», «беру соль», картинку с графиком.
  //
  // Дальше решает reconciler (reconcileAiRoute): AI разобрал уверенно → исполняем из AI (method='ai');
  // AI тоже не уверен → needs_review, ноль ордеров. Числа при этом всегда берутся у того, кто их
  // реально нашёл, — молчаливой потери сигнала больше нет ни в одной ветке.
  if (sl === null) {
    return { route: 'ai', confidence, intents: [], reason: 'no_SL' }
  }
  if (symbol === null) {
    return { route: 'ai', confidence, intents: [], reason: 'symbol_unknown' }
  }
  // ЕДИНСТВЕННОЕ исключение: символ распознан, но не торгуется на бирже. AI здесь бессилен —
  // инструмента просто нет в листинге, и звать модель значит жечь деньги ради того же ответа.
  if (!ctx.isListed(symbol)) {
    return { route: 'skip', confidence, intents: [], reason: 'symbol_not_listed' }
  }
  if (side === null || entry === null) {
    return { route: 'ai', confidence, intents: [], reason: 'incomplete_signal' }
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

  // BTC в этом правиле игнорируется как «рыночный фон» (#BTC обзор), а не как позиция.
  const tickers = allHashtags(text).filter((t) => t.toUpperCase() !== 'BTC')
  if (tickers.length === 0) return null

  const built = buildDeltaIntents(text, ctx, tickers)
  if (built === null) return null
  if ('notListed' in built) return { route: 'skip', confidence: 0.9, intents: [], reason: 'symbol_not_listed' }
  if ('escalate' in built) return { route: 'ai', confidence: 0.4, intents: [], reason: 'ambiguous_symbol' }

  // reply даёт линковку к сделке, но она избыточна для CH1 — символ сам
  // определяет позицию (изоляция «один символ — один канал», research §1 R3).
  return { route: 'execute', confidence: 0.9, intents: built.intents }
}

// ---------------------------------------------------------------------------
// R4. DELTA_STANDALONE
// ---------------------------------------------------------------------------

function tryDeltaStandalone(text: string, ctx: ParseContext): ParsedResult | null {
  if (ctx.message.replyToMsgId !== null) return null

  const tickers = allHashtags(text)
  if (tickers.length === 0) return null

  const ops = extractOps(text)
  if (ops.length === 0) return null

  // конкретный action → DET, иначе (только hold) → NOISE (research §1 R4)
  const isHoldOnly = ops.length === 1 && ops[0]?.op === 'hold'
  if (isHoldOnly) {
    return { route: 'noise', confidence: 0.2, intents: [] }
  }

  const built = buildDeltaIntents(text, ctx, tickers)
  if (built === null) return null
  if ('notListed' in built) return { route: 'skip', confidence: 0.8, intents: [], reason: 'symbol_not_listed' }
  if ('escalate' in built) return { route: 'ai', confidence: 0.4, intents: [], reason: 'ambiguous_symbol' }
  return { route: 'execute', confidence: 0.8, intents: built.intents }
}

// ---------------------------------------------------------------------------
// Фолбэк — ни одно правило не сработало.
//
// ЗДЕСЬ ЖИВЁТ НОВЫЙ ФОРМАТ КАНАЛА. Раньше сюда проваливалось всё непонятое и молча становилось
// 'noise': смени автор шаблон сигнала — и бот тихо перестал бы торговать, а в UI это выглядело бы
// как обычная болтовня. Никакой ошибки, никакого следа.
//
// Теперь непонятое уходит в AI: он не привязан к шаблону и разберёт сигнал в любой формулировке
// (или на картинке с графиком). Regex остаётся быстрым и бесплатным путём для известного формата,
// AI — страховкой для всего остального. Ровно ради этого он в боте и есть.
//
// Бесплатно отсекаем только то, где разбирать заведомо нечего: пустое сообщение без картинки
// (сервисные посты, стикеры) — звать модель на пустоту смысла нет. Явный шум (обзоры/анонсы) отсечён
// раньше по ключевым словам (tryNoiseKeywords), до этой точки он не доходит.
// ---------------------------------------------------------------------------

function fallback(ctx: ParseContext): ParsedResult {
  const hasText = (ctx.message.text ?? '').trim().length > 0
  const hasMedia = ctx.message.media !== null || ctx.message.mediaFile !== null

  if (!hasText && !hasMedia) {
    return { route: 'noise', confidence: 0, intents: [] }
  }

  // needsVision: картинка может нести сам сигнал (скрин графика с уровнями) — пусть AI её посмотрит.
  return {
    route: 'ai',
    confidence: 0,
    intents: [],
    reason: 'unknown_format',
    ...(hasMedia ? { needsVision: true } : {}),
  }
}
