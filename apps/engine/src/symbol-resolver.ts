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
 * Словарь алиасов (research §9). Кириллические склонения ("битка/битку/битке/
 * битком", "эфира/эфире/эфиром", "солана/соланы/солане/солану/соланой") резолвятся
 * по ПРЕФИКСУ — перечислить все формы нереально. Паттерны без флага `g` и без `y`
 * — .test() на них идемпотентен (нет мутируемого lastIndex), и применяются они
 * к ОТДЕЛЬНОМУ токену после tokenizeWords(), а не ко всему тексту — поэтому,
 * в отличие от направления (см. ниже), префикс здесь не даёт ложных срабатываний
 * на посторонних словах в рамках словаря дампа.
 */
// ВНИМАНИЕ: слово перед проверкой уже прошло normalize(), т.е. э уже заменено на е —
// поэтому у ETH здесь "ефир", а не "эфир" из research §9 (там регекс писался для
// сырого текста); токен "эфира" после normalize() становится "ефира".
const COIN_ALIASES: ReadonlyArray<{ symbol: string; pattern: RegExp }> = [
  { symbol: 'BTC', pattern: /^btc$|^бит/ },
  { symbol: 'ETH', pattern: /^eth$|^ефир/ },
  { symbol: 'SOL', pattern: /^sol$|^солан/ },
  { symbol: 'XRP', pattern: /^xrp$|^рипл|^риппл/ },
  { symbol: 'DOGE', pattern: /^doge$|^дог/ },
]

/** #TICKER или #TICKER/USDT -> TICKERUSDT (research §9, хэштег CH1). */
const HASHTAG_RE = /#([a-z0-9]+)(?:\/usdt)?/

/**
 * Ищет символ-кандидат в тексте: сначала стем-мап (кириллица/тикер-слова §9),
 * иначе хэштег #TICKER(/USDT)?. Листинг здесь не проверяется — это забота
 * resolveSymbol().
 */
function resolveSymbolCandidate(raw: string): string | null {
  const t = normalize(raw)
  for (const word of tokenizeWords(t)) {
    const alias = COIN_ALIASES.find((a) => a.pattern.test(word))
    if (alias) return `${alias.symbol}USDT`
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
  const symbol = resolveSymbolCandidate(raw)
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
export function extractCoins(text: string): string[] {
  const t = normalize(text)
  const coins: string[] = []
  for (const word of tokenizeWords(t)) {
    const alias = COIN_ALIASES.find((a) => a.pattern.test(word))
    if (alias && !coins.includes(alias.symbol)) coins.push(alias.symbol)
  }
  return coins
}
