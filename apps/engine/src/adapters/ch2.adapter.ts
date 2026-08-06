import { normalize } from '../normalize.js'
import { extractCoins, extractSide } from '../symbol-resolver.js'
import { parseNumbers, parseNumbersWithIndex, splitKeycaps, toNum } from 'shared/numbers.js'
import type { DeltaOp, ParseContext, ParsedIntent, ParsedResult } from 'shared/domain.js'

/**
 * Адаптер канала CH2 (форум 1962583820, тема 173666) — свободный чат
 * (docs/superpowers/research/channel-adapters.md §2, правила A–F; .superpowers/sdd/task-3-brief.md).
 *
 * Порядок применения — первый матч выигрывает: A (structured signal) → B+C (входы: лимитные и
 * рыночные разбираются ВМЕСТЕ, см. tryEntries) → D (delta_sl с тикером) → E/F (лексикон
 * символ-less дельт/amend, route ai) → фолбэк NOISE (аналитика без order-фразы, анонсы, медиа-only).
 *
 * ПОЧЕМУ у B/C/D три исхода, а не два (match/null): если СИЛЬНАЯ order-фраза (`limit`+`long/short`,
 * `с текущих`/`relong`/…, `sl`/`стоп`) в тексте нашлась, но извлечь символ/цену не удалось —
 * это НЕ шум (человек явно описывает действие с ордером), а НЕ ХВАТАЕТ данных для детерминизма
 * (символ в другом месте — reply/state/vision). Такое сообщение уходит в route `ai` с той же
 * уверенностью, что и «настоящий» E/F-фолбэк, а не проваливается молча в noise и не блокирует
 * проверку следующих правил в цепочке — именно поэтому эти функции возвращают ParsedResult
 * (не null) в этом случае, а null — только когда сама СИЛЬНАЯ фраза-гейт вообще не найдена.
 */
export function parseCh2(ctx: ParseContext): ParsedResult {
  const text = ctx.message.text ?? ''

  return (
    tryStructuredSignal(text, ctx) ??
    tryEntries(text, ctx) ??
    tryDeltaSl(text, ctx) ??
    tryAiLexicon(text) ??
    fallback(text, ctx)
  )
}

// ---------------------------------------------------------------------------
// Общие хелперы
// ---------------------------------------------------------------------------

/** Чистый тикер из хэштега `#SOLUSDT`/`#xrpUSDT` (группа БЕЗ суффикса USDT). */
const CLEAN_HASHTAG_RE = /#([a-zA-Z]{2,10})usdt/i

/**
 * Резолвит символ из произвольного фрагмента текста: сначала чистый хэштег `#TICKERUSDT`
 * (структурный сигнал), иначе первое резолвящееся коин-слово (`extractCoins`). Используется
 * для reply-parent lookup в D — задача 2 Ф1 предупреждает: резолв ВСЕГО "#SOLUSDT" через
 * ctx.resolveSymbol даёт "SOLUSDTUSDT" (слитный хэштег), поэтому здесь, как и в A, в резолвер
 * идёт ТОЛЬКО чистая группа тикера (`SOL`), а не весь хэштег с суффиксом.
 */
function resolveSymbolFromText(text: string, ctx: ParseContext): string | null {
  const hashtagMatch = CLEAN_HASHTAG_RE.exec(text)
  if (hashtagMatch) {
    const symbol = ctx.resolveSymbol(hashtagMatch[1]!) // группа обязательная — иначе regex не матчит
    if (symbol !== null && ctx.isListed(symbol)) return symbol
  }
  for (const coin of extractCoins(text)) {
    const symbol = ctx.resolveSymbol(coin)
    if (symbol !== null && ctx.isListed(symbol)) return symbol
  }
  return null
}

/**
 * Маркеры предположения/совета/обратной ссылки на прошлое (не команда сейчас) — обобщение
 * ошибки E1 (research §7): «можно со стопом 68.2» — это ПРЕДЛОЖЕНИЕ ("can/could"), не приказ;
 * «лучше оставить один объём» — совет в условной форме; «с учётом фиксации половины до этого» —
 * пояснение прошлого действия, а не новое. Такие сообщения не должны исполняться как дельты
 * ни через D (sl/стоп встречается, но это не приказ), ни через общий E/F-лексикон.
 */
// Границы слова обязательны: без них «можно» матчится ВНУТРИ «во-зможно» и глушит настоящие
// сигналы («...возможно зря перестраховывался. Если лимитку не заденет то буду искать вход по
// рынку» уходил в noise). \b здесь не годится — он ASCII-only и не создаёт границу перед кириллицей.
const SUGGESTION_MARKER_RE = /(?<![\p{L}])(можно|лучше)(?![\p{L}])|с\s+учетом/iu

// ---------------------------------------------------------------------------
// ФОЛБЭК CH2.
//
// Раньше сюда проваливалось ВСЁ непонятое и молча становилось noise: «SOL long» и «вход с текущих
// BTC long, риск 2%» получали status='noise', method=NULL — модель не вызывалась НИ РАЗУ. И это в
// канале, созданном ИМЕННО под AI-разбор свободного текста.
//
// РАЗНИЦА С CH1 — ЦЕНА. CH1 это канал сигналов, болтовни там нет. CH2 — форумный чат: «всё
// непонятое → AI» даёт 57 сообщений из 100 в модель, половина из них — «Не задело», «Надеюсь вниз
// не полетим» и пустые медиа-посты. Поэтому перед фолбэком стоит БЕСПЛАТНЫЙ гейт: сообщение должно
// упоминать монету ИЛИ торговый маркер. Замер на test/fixtures/ch2.jsonl (100 реальных сообщений
// форума): 46 → ai вместо 57, при этом ни один настоящий ордер не потерян.
// ---------------------------------------------------------------------------

/** Явный шум темы: анонсы/обзоры/рефки — разбирать нечего (аналог NOISE_KEYWORDS_RE в ch1). */
const NOISE_KEYWORDS_RE = /обзор|анонс|созвон|zoom|копитрейд|вебинар|подпис|итоги\s+недел/i

/**
 * Торговый маркер: глагол действия с ордером/позицией либо направление. Стем, а не точное слово
 * («доливаться», «лимитку», «тэйк»→«тейк» после normalize). `\b` не годится — он ASCII-only и не
 * создаёт границу перед кириллицей (та же грабля, что в symbol-resolver.ts).
 */
// СТЕМЫ — граница только СЛЕВА: «зайд» обязан ловить «зайду»/«зайдём», «закры» — «закрыл»/
// «закрываю». Правая граница здесь всё ломала: «зайду» = «зайд» + «у», и сигнал «зайду от 76.3»
// молча уходил в noise.
const TRADE_STEM_RE =
  /(?<![\p{L}\p{N}])(вход|войд|войти|захож|заход|зайд|заш[её]л|бер[уё]|взял|купил|прода|долив|доли[влью]|усредн|добра|добор|фикс|закры|прикрыва|тейк|таргет|стоп(?!роцент)|лимитк|лимит|отложк|плеч|перезах|маркет|лонг|шорт)/iu
// КОРОТКИЕ токены — граница с обеих сторон, иначе «тп» поймает «тпру», а «sl» — «slow».
const TRADE_TOKEN_RE = /(?<![\p{L}\p{N}])(тп|tp|sl|long|short|relong)(?![\p{L}\p{N}])|🎯|🛑|📈|📉/iu

function hasTradeMarker(t: string): boolean {
  return TRADE_STEM_RE.test(t) || TRADE_TOKEN_RE.test(t)
}

/** Монета в тексте: коин-слово (extractCoins) или структурный хэштег #TICKERUSDT. */
function hasCoin(text: string, ctx: ParseContext): boolean {
  if (CLEAN_HASHTAG_RE.test(text)) return true
  return extractCoins(text).some((coin) => ctx.resolveSymbol(coin) !== null)
}

function fallback(text: string, ctx: ParseContext): ParsedResult {
  const noise: ParsedResult = { route: 'noise', confidence: 0, intents: [] }
  if (text.trim().length === 0) return noise // медиа-only/сервисные сообщения — разбирать нечего

  // normalize() обязательна: без неё «тэйк» не совпадёт с «тейк», а регистр убьёт половину маркеров.
  const t = normalize(text)
  if (SUGGESTION_MARKER_RE.test(t)) return noise // «можно…», «лучше…» — совет, а не приказ
  if (NOISE_KEYWORDS_RE.test(t)) return noise // обзор/анонс/рефка

  if (hasCoin(text, ctx) || hasTradeMarker(t)) {
    const hasMedia = ctx.message.media !== null || ctx.message.mediaFile !== null
    return {
      route: 'ai',
      confidence: 0,
      intents: [],
      reason: 'unknown_format',
      ...(hasMedia ? { needsVision: true } : {}),
    }
  }
  return noise // «привет, как дела», «да, согласен полностью» — в модель не тащим
}

// ---------------------------------------------------------------------------
// A. STRUCTURED SIGNAL (research §2 A, conf 1.0)
// ---------------------------------------------------------------------------

const ENTRY_PRICE_GATE_RE = /entry price/i
const TARGETS_GATE_RE = /targets?/i
const ENTRY_RANGE_RE = /entry price:\s*([0-9.]+)\s*[-–]\s*([0-9.]+)/i
const TARGETS_LINE_RE = /targets?:?\s*([^\n]+)/i
const STOP_LOSS_RE = /stop\s*loss:?\s*([0-9.]+)/i

function tryStructuredSignal(text: string, ctx: ParseContext): ParsedResult | null {
  // гейт: #TICKERUSDT (регистронезав.) + Entry price + Targets — все три вместе (research §2 A).
  const hashtagMatch = CLEAN_HASHTAG_RE.exec(text)
  if (!hashtagMatch || !ENTRY_PRICE_GATE_RE.test(text) || !TARGETS_GATE_RE.test(text)) return null

  // ВЫРЕЗАЕМ чистый тикер (группа 1, "SOL" из "#SOLUSDT") ДО вызова резолвера — резолв всего
  // "#SOLUSDT" даёт "SOLUSDTUSDT" (заметка задачи 2 Ф1: гейт слитного #TICKERUSDT нельзя
  // прогонять через resolveSymbol целиком).
  const ticker = hashtagMatch[1]!
  const symbol = ctx.resolveSymbol(ticker)
  const side = extractSide(text)

  const entryMatch = ENTRY_RANGE_RE.exec(text)
  const entryLo = entryMatch?.[1]
  const entryHi = entryMatch?.[2]
  const entry: [number, number] | null =
    entryLo !== undefined && entryHi !== undefined ? [toNum(entryLo), toNum(entryHi)] : null

  const targetsMatch = TARGETS_LINE_RE.exec(text)
  const targetsLine = targetsMatch?.[1]
  // keycap-сплит целей (research §3): "1️⃣80.82️⃣82.33️⃣84" -> [80.8,82.3,84].
  const tps = targetsLine !== undefined ? splitKeycaps(targetsLine) : []

  const slMatch = STOP_LOSS_RE.exec(text)
  const slRaw = slMatch?.[1]
  const sl = slRaw !== undefined ? toNum(slRaw) : null

  if (symbol === null) return { route: 'skip', confidence: 1.0, intents: [], reason: 'symbol_unknown' }
  if (!ctx.isListed(symbol)) {
    return { route: 'skip', confidence: 1.0, intents: [], reason: 'symbol_not_listed' }
  }
  if (side === null || entry === null || sl === null) {
    return { route: 'skip', confidence: 1.0, intents: [], reason: 'incomplete_signal' }
  }

  const intent: ParsedIntent = { kind: 'entry_signal', symbol, side, entry, tps, sl }
  return { route: 'execute', confidence: 1.0, intents: [intent] }
}

// ---------------------------------------------------------------------------
// B + C. ВХОДЫ — ЛИМИТНЫЕ И РЫНОЧНЫЕ РАЗБИРАЮТСЯ ВМЕСТЕ.
//
// Раньше правила стояли в цепочке «первый матч выигрывает» (B ?? C), и сообщение, где автор
// смешал оба способа входа, теряло часть строк МОЛЧА. Живой случай прода 06.08.2026 (msg 221563):
//
//     С текущих long Xrp        <- C (рыночный вход)  — ПРОПАЛ: правило C не запускалось вовсе
//     Limit long Eth - 1895     <- B (лимитка)
//     Limit long SOL - 73.1     <- B (лимитка)
//
// B вернул два интента и остановил цепочку — по XRP не появилось даже строки действия: ни
// executed, ни skipped, просто ничего. Теперь по сообщению проходят ОБА сканера, а их интенты
// складываются в порядке строк. Взаимные помехи исключены двумя правилами:
//   1) строка, отдавшая лимитку, рыночному сканеру не показывается (иначе «с текущих» в соседней
//      строке затянуло бы тот же символ во ВТОРОЙ вход);
//   2) символ, уже занятый лимиткой этого сообщения, рыночный сканер пропускает.
// ---------------------------------------------------------------------------

const LIMIT_GATE_RE = /\blimit\b/i
const DIR_WORD_GATE_RE = /\b(long|short)\b/i

/** Интент вместе с номером строки-источника — чтобы итоговый порядок совпадал с порядком в тексте. */
interface EntryHit {
  line: number
  intent: ParsedIntent
}

interface EntryScan {
  /** Гейт правила сработал: в тексте реально есть order-фраза этого вида. */
  gated: boolean
  hits: EntryHit[]
  /** Строки, уже отданные под лимитки, — рыночный сканер их не смотрит. */
  consumed: Set<number>
  /** Сколько символов сканер намеренно пропустил как уже занятые другим правилом. */
  suppressed: number
}

function tryEntries(text: string, ctx: ParseContext): ParsedResult | null {
  const lines = text.split('\n')

  const limit = scanLimitEntries(lines, ctx)
  // Гасим (не удаляем!) занятые строки, чтобы номера остальных не поехали.
  const leftover = lines.map((line, i) => (limit.consumed.has(i) ? '' : line))
  const claimed = new Set(limit.hits.map((h) => (h.intent as { symbol: string }).symbol))
  const market = scanMarketEntries(leftover, ctx, claimed)

  if (!limit.gated && !market.gated) return null

  // Один из гейтов сработал, но НИ ОДНОГО интента не дал, пока другой дал. Исполнить половину и
  // промолчать про вторую — ровно тот дефект, из-за которого пропал XRP. Отдаём всё сообщение
  // модели: она видит его целиком, а не по одной строке. `suppressed` — это НЕ потеря: символ
  // уже вошёл лимиткой этого же сообщения («Limit long Eth 1895 / с текущих тоже беру eth»).
  const halfParsed =
    (limit.gated && limit.hits.length === 0) || (market.gated && market.hits.length === 0 && market.suppressed === 0)
  const hits = [...limit.hits, ...market.hits].sort((a, b) => a.line - b.line)

  if (hits.length === 0) {
    // Гейт сработал, но структуры нет вовсе — напр. "Limit long на ту половину которую фиксировал"
    // (221420: ссылка на прошлую позицию без символа/цены) или "С текущих беру" (221393, символ
    // только в state/reply). Реальная order-фраза без структуры → в AI, а не в noise.
    return { route: 'ai', confidence: 0.4, intents: [] }
  }
  if (halfParsed) return { route: 'ai', confidence: 0.4, intents: [], reason: 'partial_entry_parse' }

  // Уверенность — по слабейшему из сработавших правил (research §2: B 0.8, C 0.7).
  return { route: 'execute', confidence: market.hits.length > 0 ? 0.7 : 0.8, intents: hits.map((h) => h.intent) }
}

function scanLimitEntries(lines: readonly string[], ctx: ParseContext): EntryScan {
  const scan: EntryScan = { gated: false, hits: [], consumed: new Set(), suppressed: 0 }
  if (!LIMIT_GATE_RE.test(lines.join('\n')) || !DIR_WORD_GATE_RE.test(lines.join('\n'))) return scan
  scan.gated = true

  lines.forEach((line, index) => {
    // Строка со СВОЕЙ рыночной фразой принадлежит правилу C, даже когда слово limit есть в
    // соседней строке: «С текущих long Xrp по 0.62» — это вход по рынку с упомянутым уровнем,
    // а не лимитка на 0.62.
    if (MARKET_ENTRY_GATE_RE.test(line) && !LIMIT_GATE_RE.test(line)) return
    // Сплит по ` + ` (несколько ордеров в одной строке, research §2 B):
    // "Limit long btc 60850 + limit long btc 60000" -> 2 сегмента.
    for (const segment of line.split(' + ')) {
      const side = extractSide(segment)
      const coin = extractCoins(segment)[0]
      const numbers = parseNumbers(segment)
      if (side === null || coin === undefined || numbers.length === 0) continue
      const symbol = ctx.resolveSymbol(coin)
      if (symbol === null || !ctx.isListed(symbol)) continue
      const price = numbers[numbers.length - 1]! // последнее число в сегменте — цена (research §2 B)
      scan.hits.push({ line: index, intent: { kind: 'limit_entry', symbol, side, price } })
      scan.consumed.add(index)
    }
  })
  return scan
}

// ---------------------------------------------------------------------------
// C. MARKET_ENTRY (research §2 C, conf 0.7)
// ---------------------------------------------------------------------------

const MARKET_ENTRY_GATE_RE = /с текущих|relong|перезах|повторный лонг|пробую с/i

/**
 * «ЕЩЁ ОДИН» — это ДОБОР, а не новый вход.
 *
 * Живой случай прода 29.07.2026: «Ещё один Лонг битка с текущих» разобрался как новый
 * `market_entry`, символ был занят открытой сделкой, и вход ушёл в skip(symbol_busy) — то есть
 * прямое указание автора долить позицию бот проигнорировал.
 *
 * Отличать добор от повторного сигнала обязательно: просто повторённый сигнал по занятому символу
 * (дубль пересылки) skip'ается намеренно — иначе позиция удваивалась бы на пустом месте (см.
 * e2e-сценарий ch1-busy). Разделяет их именно формулировка «ещё/добираю/доливаю/усредняю» плюс
 * факт открытой позиции по этому символу.
 */
const ADD_INTENT_RE = /(?:ещ[её]\s+(?:один|одну|раз)|добир|добор|долив|доли[влью]|добавля|усредн)/i

/**
 * @param lines строки сообщения БЕЗ тех, что уже отдали лимитку (они погашены пустыми — номера
 *   остальных при этом сохраняются).
 * @param claimed символы, уже вошедшие лимиткой этого же сообщения: второй вход по ним не нужен.
 */
function scanMarketEntries(lines: readonly string[], ctx: ParseContext, claimed: ReadonlySet<string>): EntryScan {
  const scan: EntryScan = { gated: false, hits: [], consumed: new Set(), suppressed: 0 }
  const text = lines.join('\n')
  if (!MARKET_ENTRY_GATE_RE.test(text)) return scan
  scan.gated = true

  // Якорь порядка — первая строка с рыночной фразой: правило C собирает коины со ВСЕГО текста
  // («С текущих\nSol Eth btc» — фраза и монеты в разных строках), поэтому своей строки у
  // отдельного интента нет.
  const anchor = Math.max(
    lines.findIndex((line) => MARKET_ENTRY_GATE_RE.test(line)),
    0,
  )
  const side = extractSide(text)
  const wantsAdd = ADD_INTENT_RE.test(text)
  const seen = new Set<string>(claimed)
  // syms = ВСЕ коины в тексте (research §2 C): "Перезахожу в Лонги Sol Eth btc" -> [SOL,ETH,BTC].
  for (const coin of extractCoins(text)) {
    const symbol = ctx.resolveSymbol(coin)
    if (symbol === null || !ctx.isListed(symbol)) continue
    if (seen.has(symbol)) {
      scan.suppressed += 1
      continue
    }
    const open = ctx.openPositions.get(symbol)
    // Добор — только когда позиция по символу РЕАЛЬНО открыта. Иначе «ещё один лонг» по свободному
    // символу — обычный вход (автор мог закрыть прошлую сделку раньше). Сторону для добора можно не
    // называть («Добираю битка с текущих») — она известна из самой позиции.
    if (wantsAdd && open !== undefined) {
      seen.add(symbol)
      scan.hits.push({ line: anchor, intent: { kind: 'add', symbol, side: side ?? open.side } })
      continue
    }
    if (side !== null) {
      seen.add(symbol)
      scan.hits.push({ line: anchor, intent: { kind: 'market_entry', symbol, side } })
    }
  }
  return scan
}

// ---------------------------------------------------------------------------
// D. DELTA_SL с тикером (research §2 D, conf 0.75 → DET; без тикера → 0.4 AI)
// ---------------------------------------------------------------------------

const SL_GATE_RE = /\bsl\b|стоп[а-яё]*/i
const BE_MARKER_RE = /на твх|в бу|б\/у/i
/** «50%», «50 %» — доля фиксации, а не цена: вырезаем перед поиском цены стопа. */
const PERCENT_NUM_RE = /\d+(?:[.,]\d+)?\s*%/g

/**
 * Извлекает DeltaOp из ОДНОЙ строки, уже прошедшей гейт SL_GATE_RE. be — раньше price:
 * если строка про перевод в БУ/твх, число ЦЕЛИ из той же строки НЕ должно затягиваться как
 * цена стопа (research §7 E3: "Sol Sl на твх … Следующие цели 75, 76.5" — price должен
 * остаться null, а не 75). Возвращает null, если в строке нет ни be-маркера, ни числа.
 */
// Строка про ЦЕЛЬ с ценой: «Первый тейк по битку 63950», «цель по эфиру 1943». Порядковое слово
// даёт номер ступени лесенки — по нему пайплайн понимает, что названа ОДНА цель из нескольких, и
// закрывает долю, а не весь объём.
const TP_GATE_RE = /тейк|цел[ьи]|таргет/i
const TP_ORDINAL_RE = /(перв|втор|трет|четв[её]рт|пят)[а-яё]*/i
const TP_ORDINALS = ['перв', 'втор', 'трет', 'четв', 'пят'] as const

// Строка про выход из позиции: «Около бу закрываю Солану», «остаток по эфиру фиксирую».
// Отрицание («не закрываю») сюда не должно попадать — его отсекает SUGGESTION/negation-гейт ниже.
const CLOSE_GATE_RE = /закрыва(ю|ем)|закрою|фиксир[а-яё]*|остат[а-яё]*/i
// Граница слова через (?<![\p{L}\p{N}]) с флагом u, а НЕ \b: в JS \b опирается на ASCII-\w, и
// перед кириллической «н» после пробела он не срабатывает вовсе — отрицание молча не ловилось.
const CLOSE_NEGATION_RE = /(?<![\p{L}\p{N}])не\s+(?:буду\s+)?(закрыва|фиксир|выхо)/iu

/** Номер названной ступени: «Первый тейк» -> 1. Нет порядкового слова — номер неизвестен. */
function tpIndexOf(line: string): number | undefined {
  const m = TP_ORDINAL_RE.exec(line)
  if (m === null) return undefined
  const stem = m[1]!.slice(0, 4).toLowerCase()
  const index = TP_ORDINALS.findIndex((o) => stem.startsWith(o.slice(0, 4)))
  return index >= 0 ? index + 1 : undefined
}

/** Цель из строки: цена + (если названа) номер ступени. */
function extractTpOpFromLine(line: string): DeltaOp | null {
  if (!TP_GATE_RE.test(line)) return null
  const numbers = parseNumbers(line.replace(PERCENT_NUM_RE, (m) => ' '.repeat(m.length)))
  if (numbers.length === 0) return null
  const index = tpIndexOf(line)
  return { op: 'tp_set', targets: numbers.map((value) => ({ value, ...(index !== undefined ? { index } : {}) })) }
}

/** Выход из позиции: «закрываю Солану» — весь остаток; «фиксирую» без доли решает пайплайн. */
/** Доля, названная СЛОВОМ: «половину» -> 0.5, «треть» -> 1/3. «часть» доли не задаёт. */
const FRACTION_WORDS: ReadonlyArray<{ re: RegExp; fraction?: number }> = [
  { re: /половин|1\/2/i, fraction: 0.5 },
  { re: /треть|1\/3/i, fraction: 1 / 3 },
  { re: /четверт|1\/4/i, fraction: 0.25 },
  { re: /част[ьи]/i },
]

/** Признаки, что закрывается ВСЁ, а не доля. */
const FULL_EXIT_RE = /позици|полностью|остат[а-я]*|целиком|вс[ею]\s|весь\s/i

function extractCloseOpFromLine(line: string): DeltaOp | null {
  if (!CLOSE_GATE_RE.test(line) || CLOSE_NEGATION_RE.test(line)) return null

  // Доля важнее всего: «фиксирую 50% позиции» — частичная фиксация, хотя слово «позиции» и есть.
  const pct = /(\d{1,3})\s*%/.exec(line)
  if (pct !== null) return { op: 'partial_close', fraction: Number(pct[1]) / 100 }
  const word = FRACTION_WORDS.find((w) => w.re.test(line))
  if (word) return { op: 'partial_close', ...(word.fraction !== undefined ? { fraction: word.fraction } : {}) }

  // Полный выход — только когда он назван явно («закрываю Солану», «фиксирую позицию»). Голое
  // «фиксирую» без уточнения означает частичную фиксацию (та же конвенция, что в лексиконе CH1):
  // закрыть по нему ВСЮ позицию было бы куда дороже ошибкой, чем закрыть половину.
  if (FULL_EXIT_RE.test(line) || /закрыва(ю|ем)|закрою/i.test(line)) return { op: 'close_remainder' }
  return { op: 'partial_close' }
}

function extractSlOpFromLine(line: string): DeltaOp | null {
  if (BE_MARKER_RE.test(line)) return { op: 'sl_breakeven' }

  const marker = SL_GATE_RE.exec(line)
  if (marker === null) return null

  // Цена стопа — число, БЛИЖАЙШЕЕ к слову «стоп», хоть справа («стоп 70000»), хоть слева
  // («74600 стоп по битку» — привычная манера автора CH2). Ни «первое число строки» (брало «50»
  // из «Фикс 50% BTC, стоп 70000» → стоп $50 на BTC), ни «только хвост после маркера» (терял
  // цену, стоящую ПЕРЕД словом) не годятся. Проценты вырезаем, сохраняя позиции (замена на
  // пробелы той же длины), иначе «50%» сдвинула бы индексы и «ближайшее» посчиталось бы неверно.
  const masked = line.replace(PERCENT_NUM_RE, (m) => ' '.repeat(m.length))
  const markerMid = marker.index + marker[0].length / 2
  const numbers = parseNumbersWithIndex(masked)
  if (numbers.length === 0) return null
  const nearest = numbers.reduce((best, n) =>
    Math.abs(n.index - markerMid) < Math.abs(best.index - markerMid) ? n : best,
  )
  return { op: 'sl_set', price: nearest.value }
}

function tryDeltaSl(text: string, ctx: ParseContext): ParsedResult | null {
  // Правило разбирает ПОСТРОЧНЫЕ инструкции с тикером: стоп, цель, выход. Раньше гейт был только
  // на стоп — и сообщение «Около бу закрываю Солану / По битку ставлю стоп в бу / Первый тейк по
  // битку 63950» давало ОДИН интент (стоп), а остальные две строки молча пропадали: маршрут при
  // этом оставался детерминированным, и модель к ним не вызывалась (живой случай 02.08.2026).
  const LINE_GATE_RE = new RegExp(`${SL_GATE_RE.source}|${TP_GATE_RE.source}|${CLOSE_GATE_RE.source}`, 'i')
  if (!LINE_GATE_RE.test(text) || SUGGESTION_MARKER_RE.test(text)) return null

  const lines = text.split('\n')
  const gateLines = lines.filter((line) => LINE_GATE_RE.test(line))
  const intents: ParsedIntent[] = []

  // Прямое извлечение: символ БЕРЁМ ТОЛЬКО со строки, где стоит sl/стоп (research §7 вывод —
  // не «первое коин-слово» из всего сообщения). Так "Sl 74\nМожет быть … по битку" (221445)
  // НЕ даёт ложный BTCUSDT: "битку" находится на второй строке, где нет sl/стоп-гейта.
  for (const line of gateLines) {
    const coin = extractCoins(line)[0]
    if (coin === undefined) continue
    const symbol = ctx.resolveSymbol(coin)
    if (symbol === null || !ctx.isListed(symbol)) continue
    // Порядок важен: строка «стоп в бу» может содержать и число цели — стоп забирает её первым
    // (см. extractSlOpFromLine), а цель без стоп-маркера уходит в TP-ветку.
    const op = extractSlOpFromLine(line) ?? extractTpOpFromLine(line) ?? extractCloseOpFromLine(line)
    if (op === null) continue
    intents.push({ kind: 'delta', symbol, ops: [op] })
  }

  if (intents.length === 0) {
    // Ни одна sl/стоп-строка не дала символ напрямую — единственный хоп по reply-родителю
    // (research §7: приоритет reply → state → coin-в-тексте; в CH2 у 84% reply бесполезен,
    // но когда родитель разрешается (пример 221445 → reply 221443, структурный #SOLUSDT-сигнал),
    // это лучше, чем гадать по случайному коин-слову в другой строке).
    const replyId = ctx.message.replyToMsgId
    const parent = replyId !== null ? ctx.getMessage(replyId) : null
    const parentSymbol = parent !== null ? resolveSymbolFromText(parent.text, ctx) : null
    const anchorLine = gateLines[0]
    if (parentSymbol !== null && anchorLine !== undefined) {
      const op = extractSlOpFromLine(anchorLine)
      if (op !== null) intents.push({ kind: 'delta', symbol: parentSymbol, ops: [op] })
    }
  }

  if (intents.length === 0) {
    // Гейт сработал (реально пишут про sl/стоп), но ни текст, ни reply не дали символ/цену —
    // "DELTA_SL без тикера" (research §2 D, conf 0.4 → AI, нужен state/vision).
    return { route: 'ai', confidence: 0.4, intents: [] }
  }
  return { route: 'execute', confidence: 0.75, intents }
}

// ---------------------------------------------------------------------------
// E/F. Символ-less дельты и amend (research §2 E/F) — .superpowers/sdd/task-3-brief.md
// сознательно упрощает оба правила до одного маршрута: "всё остальное" (`2🎯`, `Фикс половину`,
// аменды целей, свободный текст с явным action-словом) → route `ai`. Разбивка на under-
// капотные E ("тейк/цель/фикс/объём/…") и F ("🛑/таргет/следующие цели") в research —
// иллюстративная, для CH2 они дают один и тот же исход (ai), поэтому не разделены на два правила.
// ---------------------------------------------------------------------------

const AI_LEXICON_RE =
  /🎯|перв(ый|ая|ые)\s*(тейк|цел|таргет)|фикс|об[ъь]?ем|закрыва|закрыл\s+остаток|🛑|таргет|следующие\s+цели/i

function tryAiLexicon(text: string): ParsedResult | null {
  if (text.trim().length === 0) return null // пусто (медиа-only) — в noise-фолбэк
  if (SUGGESTION_MARKER_RE.test(text)) return null // предположение/совет — не команда
  if (!AI_LEXICON_RE.test(text)) return null
  return { route: 'ai', confidence: 0.35, intents: [] }
}
