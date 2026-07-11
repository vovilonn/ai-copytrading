/**
 * Разбор сырого фрейма Bybit `tickers.<symbol>` (research bybit-execution.md §12): первый пуш —
 * `type:"snapshot"` (полный набор полей), далее `type:"delta"` каждые ~100–300мс — ТОЛЬКО
 * изменившиеся поля, `markPrice` присутствует в большинстве, но не в каждой дельте.
 *
 * Ф1 фронту/движку нужен ТОЛЬКО markPrice — не держим общий кеш "снапшот+дельта" по всем полям
 * тикера (§12 рекомендует это для полноценного live-тикера в UI): дельта без markPrice просто
 * игнорируется здесь как "нет нового тика цены" — следующая дельта или снапшот рано или поздно
 * принесут его снова (реальный поток — десятки сообщений в секунду на символ).
 */
export interface MarkPriceTick {
  symbol: string
  markPrice: string
}

const TOPIC_PREFIX = 'tickers.'

/** null — не тик цены (ack подписки/pong/чужой топик/битый JSON/дельта без markPrice). */
export function parseMarkPriceTick(raw: string): MarkPriceTick | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null

  const topic = (msg as { topic?: unknown }).topic
  if (typeof topic !== 'string' || !topic.startsWith(TOPIC_PREFIX)) return null

  const data = (msg as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null

  const markPrice = (data as { markPrice?: unknown }).markPrice
  if (typeof markPrice !== 'string' || markPrice === '') return null

  return { symbol: topic.slice(TOPIC_PREFIX.length), markPrice }
}
