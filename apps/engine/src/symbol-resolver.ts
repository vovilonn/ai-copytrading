import { normalize } from './normalize.js'

/**
 * Слово — последовательность Unicode-букв/цифр, ограниченная НЕ-буквенными/
 * НЕ-цифровыми символами с обеих сторон. JS `\b` — ASCII-only и не создаёт
 * границу перед кириллицей (research channel-adapters.md §4, критичный баг),
 * поэтому вместо `\b` — явные lookaround-границы `(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])`.
 */
const WORD_RE = /(?<![\p{L}\p{N}])[\p{L}\p{N}]+(?![\p{L}\p{N}])/gu

function tokenizeWords(text: string): string[] {
  return [...text.matchAll(WORD_RE)].map((m) => m[0]!) // группа 0 — всегда весь матч, не может быть undefined
}

/**
 * Словарь алиасов (research §9). Кириллические склонения перечислены ЯВНО и заякорены
 * с обеих сторон (`^...$`), а не префиксом — префикс ловит посторонние слова с тем же
 * началом (КРИТИЧНЫЙ баг: `^бит` матчил «битва»/«битву», `^дог` матчил «договор»/
 * «догнать», т.к. регекс проверялся против уже вычлененного tokenizeWords() токена
 * целиком, но без якоря `$` совпадение прекращалось на префиксе). Паттерны без флага
 * `g` и без `y` — .test() на них идемпотентен (нет мутируемого lastIndex).
 */
// ВНИМАНИЕ: слово перед проверкой уже прошло normalize(), т.е. э уже заменено на е —
// поэтому у ETH здесь "ефир", а не "эфир" из research §9 (там регекс писался для
// сырого текста); токен "эфира" после normalize() становится "ефира".
// ПАДЕЖИ ПЕРЕЧИСЛЯЮТСЯ ЦЕЛИКОМ. Пропущенная форма — это молча потерянная инструкция: «по эфиру
// стоп в бу» не резолвился вовсе, потому что в списке был «ефир|ефира|ефире|ефиром», но не
// «ефиру». Живой разбор 13.08.2026 показал дыры сразу в трёх монетах (эфиру, биткоин*, рипле).
const COIN_ALIASES: ReadonlyArray<{ symbol: string; pattern: RegExp }> = [
  // бит/биток/битка/битке/битку/битком + полное «биткоин/биткойн» во всех падежах — но НЕ
  // "битва"/"битвы" (после "бит" не "в").
  { symbol: 'BTC', pattern: /^btc$|^bitcoin$|^бит(ок|ка|ке|ку|ком)?$|^битко(ин|йн)(а|е|у|ом)?$/ },
  // ефир/ефира/ефире/ефиру/ефиром ("эфир" после normalize) + «ефириум» — но НЕ "ефирный".
  { symbol: 'ETH', pattern: /^eth$|^ether$|^ефир(а|е|у|ом)?$|^ефириум(а|е|у|ом)?$/ },
  // солана/соланы/солане/солану/соланой — но НЕ "солнце" (буквы после "сол" другие).
  { symbol: 'SOL', pattern: /^sol$|^solana$|^солан(а|ы|е|у|ой)?$/ },
  { symbol: 'XRP', pattern: /^xrp$|^ripple$|^рипл(а|е|у|ом)?$|^риппл(а|е|у|ом)?$/ },
  // дог/доге/дога/догу — но НЕ "договор"/"догнать"/"догадка" (после "дог" не "е"/"а"/"у").
  { symbol: 'DOGE', pattern: /^doge$|^дог(е|а|у)?$/ },
]

/** #TICKER или #TICKER/USDT -> TICKERUSDT (research §9, хэштег CH1). */
const HASHTAG_RE = /#([a-z0-9]+)(?:\/usdt)?/

/**
 * ГОЛЫЙ ТИКЕР СВЕРЯЕТСЯ С КАТАЛОГОМ ИНСТРУМЕНТОВ.
 *
 * COIN_ALIASES выше — закрытый список из пяти монет, а биржа листингует сотни. Всё, что автор
 * называет просто тикером, для разбора не существовало: живой случай 22.09.2026 (msg 221780)
 * «1000pepe limit long 0.0046 … + limit long btc 84600» выставил ТОЛЬКО биток, строка про pepe
 * исчезла молча — ни ордера, ни skip, ни следа в UI. Дамп канала показывает тот же провал ещё у
 * полутора десятков монет (inj, jup, ldo, arb, pyth, tia, near, ondo, apt, link…).
 *
 * Поэтому слово, не попавшее в алиасы, проверяется по КАТАЛОГУ активной сети (тот же `isListed`,
 * которым резолвер и так пользуется). Каталог — источник правды: выдумать монету, которой нет в
 * листинге, эта ветка не может.
 *
 * Три ограничителя против ложных монет (замерены на 658 реальных сообщениях обоих каналов):
 *  1) только латиница и хотя бы одна буква — кириллица идёт через алиасы, а «84600» и «4» из цены
 *     не должны становиться тикером 4USDT;
 *  2) не короче трёх символов — иначе «Sol long c текущих» дало бы CUSDT, «волна b» — BUSDT,
 *     а «us»/«re» из ссылок — USUSDT/REUSDT;
 *  3) структурные слова разбора (limit/long/stop/high/risk…) монетой не считаются, даже если
 *     тикер с таким именем существует.
 */
const LOT_PREFIXES = ['1000', '10000', '1000000'] as const
const MIN_TICKER_LEN = 3
const LATIN_TICKER_RE = /^[a-z0-9]+$/
const HAS_LETTER_RE = /[a-z]/
const NOT_A_COIN = new Set([
  'limit', 'long', 'short', 'relong', 'stop', 'take', 'profit', 'loss', 'entry', 'exit',
  'buy', 'sell', 'high', 'low', 'risk', 'open', 'close', 'market', 'spot', 'usdt', 'usd',
])

/**
 * Слово -> имя монеты из каталога, либо null. Мем-монеты биржа листингует с множителем
 * (1000PEPE, 10000SATS, 1000000BABYDOGE), а автор пишет «pepe» — поэтому после точного совпадения
 * пробуем те же префиксы.
 */
function catalogCoin(word: string, isListed: (symbol: string) => boolean): string | null {
  if (word.length < MIN_TICKER_LEN) return null
  if (!LATIN_TICKER_RE.test(word) || !HAS_LETTER_RE.test(word)) return null
  if (NOT_A_COIN.has(word)) return null

  const ticker = word.toUpperCase()
  if (isListed(`${ticker}USDT`)) return ticker
  for (const prefix of LOT_PREFIXES) {
    if (isListed(`${prefix}${ticker}USDT`)) return `${prefix}${ticker}`
  }
  return null
}

/**
 * Ищет символ-кандидат в тексте: сначала стем-мап (кириллица/тикер-слова §9),
 * иначе хэштег #TICKER(/USDT)?. Листинг здесь не проверяется — это забота
 * resolveSymbol().
 */
function resolveSymbolCandidate(raw: string, isListed?: (symbol: string) => boolean): string | null {
  const t = normalize(raw)
  for (const word of tokenizeWords(t)) {
    const alias = COIN_ALIASES.find((a) => a.pattern.test(word))
    if (alias) return `${alias.symbol}USDT`
    // Алиасов на все монеты биржи нет и быть не может — голый тикер сверяем с каталогом.
    const fromCatalog = isListed ? catalogCoin(word, isListed) : null
    if (fromCatalog !== null) return `${fromCatalog}USDT`
  }
  const m = HASHTAG_RE.exec(t)
  const ticker = m?.[1]
  if (ticker) return `${ticker.toUpperCase()}USDT`
  return null
}

/**
 * Резолвит сырое упоминание монеты (кириллица/тикер/хэштег) в символ Bybit.
 * Возвращает символ, ТОЛЬКО если isListed(symbol) вернул true — иначе null
 * (символ не распознан ИЛИ распознан, но не торгуется на активной сети,
 * research §8: символ есть в дампе, но снят с листинга/недоступен).
 */
export function resolveSymbol(raw: string, isListed: (symbol: string) => boolean): string | null {
  const symbol = resolveSymbolCandidate(raw, isListed)
  return symbol !== null && isListed(symbol) ? symbol : null
}

/**
 * Маркеры направления (research §4). Границы — Unicode lookaround, а не `\b`.
 *
 * КРИТИЧНО, в отличие от COIN_ALIASES выше: здесь ТОЧНОЕ совпадение слова
 * целиком (границы с обеих сторон токена), а не префикс. "шортовом" (аналитика
 * "в шортовом брейкере") НЕ должен давать ложный short, хотя и начинается на
 * "шорт" — префиксный разбор (как у монет) здесь дал бы ложное срабатывание.
 * "лонги" в списке long — не префиксное обобщение, а отдельная перечисленная
 * форма из дампа (research §4: "Лонг/Лонги/лонг"), симметричной формы "шорты"
 * в дампе не встречалось, поэтому её и нет в списке.
 */
const LONG_WORD_RE = /(?<![\p{L}\p{N}])(long|лонг|лонги|relong)(?![\p{L}\p{N}])/u
const SHORT_WORD_RE = /(?<![\p{L}\p{N}])(short|шорт)(?![\p{L}\p{N}])/u

/**
 * Извлекает направление сделки из текста. null — если маркеров нет, они
 * противоречат друг другу (и long, и short в одном тексте), или совпадение
 * ложное (см. комментарий выше про "шортовом").
 */
export function extractSide(text: string): 'long' | 'short' | null {
  const t = normalize(text)
  const isLong = t.includes('📈') || LONG_WORD_RE.test(t)
  const isShort = t.includes('📉') || SHORT_WORD_RE.test(t)
  if (isLong === isShort) return null // ни одного маркера, либо оба сразу — не наш случай
  return isLong ? 'long' : 'short'
}

/**
 * Все коин-слова из текста в порядке появления, без дублей (для мульти-
 * символьных сообщений, напр. "Перезахожу в Лонги Sol Eth btc" -> [SOL,ETH,BTC]).
 * Фильтрация по контексту (уместно ли это упоминание как символ сделки) —
 * забота адаптера канала (задача 3), не этой функции.
 */
export function extractCoins(text: string, isListed?: (symbol: string) => boolean): string[] {
  const t = normalize(text)
  const coins: string[] = []
  for (const word of tokenizeWords(t)) {
    const alias = COIN_ALIASES.find((a) => a.pattern.test(word))
    const coin = alias?.symbol ?? (isListed ? catalogCoin(word, isListed) : null)
    if (coin !== null && coin !== undefined && !coins.includes(coin)) coins.push(coin)
  }
  return coins
}
