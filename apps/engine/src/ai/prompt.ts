// Сборка user-turn для extract_signal (research/ai-layer.md §4.1/§4.2/§4.4/§9/§10).
// Прокси МОЛЧА игнорирует поле `system` (§1) — вся инструкция подаётся первым текстовым
// блоком user-сообщения с `cache_control:{type:'ephemeral'}`. Кэшируется весь prefix
// tools+CC-система+этот блок (§10, ~4841 ток стабильно) — поэтому EXTRACTOR_INSTRUCTION
// ДОЛЖНА оставаться байт-в-байт одинаковой между вызовами (без даты/uuid/переменных данных).

import type { Side } from 'shared/domain.js'

/**
 * Системная инструкция экстрактора (research §4.1, дословно). Подаётся первым user-блоком
 * с `cache_control`. Схема `extract_signal` не дублируется здесь текстом — она уже форсится
 * полем `tools` запроса (client.ts), и попадает в тот же кэшируемый prefix перед этим блоком.
 */
export const EXTRACTOR_INSTRUCTION = `You parse messages from a crypto futures signal channel for an automated copy-trading bot on Bybit (category=linear, USDT perps). Output ONE tool call to extract_signal.

CORE RULE — NEVER DO ARITHMETIC. Emit symbolic markers for any value that must be computed downstream:
- "стоп в б/у" / "стоп в бу" / "безубыток" / "стоп на твх" / "стоп на точку входа" => stop_loss.mode="marker", marker="entry_price" (DO NOT output a price number).
- "по текущим" / "с текущих" / "по рынку" / "по факту" => market / current_price marker (no number).
- "фикс половину" / "50%" => close_amount mode="fraction" value=0.5. "75%" => 0.75. "остаток"/"всё" => mode="all".
- "скинул один объём" / "один объём закрыт" => close_amount mode="units" marker="one_unit".
- "убираю стоп" => stop_loss.mode="remove".

ACTION TYPES:
- open: brand-new position (new symbol/side). Includes structured cards, "Limit long Xrp - 1.118", "Sol long с текущих", "Перезахожу в Лонги Sol Eth btc" (one open per symbol).
- add: добор/доливка into an EXISTING position ("+ limit long btc 60000", "58100 extra limit long btc", "буду доливаться", "ставлю лимитку на 61000"). "Ещё один лонг битка с текущих" / "добираю" / "усредняю" on a symbol that is ALREADY in the open-positions list is add — NOT a second open (a plain repeated signal without «ещё/добираю» stays open and is rejected as a duplicate downstream).
- close: partial or full fix ("первая цель, зафиксировал 50%", "закрываю остаток", "Фикс половину", "Закрываю все Лонги").
- modify_sl / modify_tp: change stop or targets ("Sl btc - 64300", "Следующие цели 72.7, 74", "Стоп на твх").
- cancel_order: cancel a pending limit ("лимитка не актуальна не задели").
- tp_hit / sl_hit: report an exchange event ("выбило по стоп-лоссу"/"выбило в бу"/"закрыло в бу"/"стоп сработал"=sl_hit; "первая цель есть"/"2🎯"/"1🎯"=tp_hit). These are events, not new orders.
  A PRICE next to "цель/таргет" WITHOUT an achievement marker NAMES a target => modify_tp, never tp_hit.
  "64200 первый таргет" / "первая цель 64200" / "цели 64200 и 65000" => modify_tp(targets=[...]).
  tp_hit requires an achievement marker (🎯, "есть", "взяли", "забрали", "отработала", a result card)
  AND is normally priceless — the author reports what already happened, not where to aim.

CO-OCCURRING EVENTS: a single message often mixes a SETUP action with a HIT event on the same symbol — emit ALL of them, never collapse into one. E.g. "Стоп на твх ... Выбило в бу" => modify_sl(marker=entry_price) AND sl_hit (the stop was moved to breakeven AND then triggered). "Первая цель 71.27🎯 ... Следующие 72.7,74" => tp_hit AND modify_tp. Setting/showing pending target orders ("Первые цели"/"Следующие цели"/a screenshot of pending "Закрыть лонг" trigger orders) is modify_tp, NOT tp_hit — tp_hit is reserved for a target actually REACHED ("2🎯", a WEEX result card showing +% with Цена закрытия).

BREAKEVEN IS A PRICE LEVEL, NOT AN ORDER. "твх"/"безубыток"/"БУ" name the entry price. Emit modify_sl(marker=entry_price) ONLY when the author actually says to move the stop there ("стоп в бу", "перевожу стоп на твх", "sl на безубыток"). A bare statement of where breakeven now sits — "после усреднения твх 1.03" — is context for what follows, NOT a stop instruction: attaching a stop at that level would be flat wrong (for a long in drawdown it sits ABOVE market and the exchange rejects it).

EXIT AT A NAMED PRICE IS A TARGET, NOT A CLOSE. "на 1.03 скину доливку", "там буду фиксировать половину", "выйду на 1.05" describe a reduce-only order WAITING at that price => modify_tp with a take_profits entry at that price. close/partial_close is only for what happens NOW ("фиксирую половину", "закрыл остаток"). When the portion is a leg rather than a percentage ("скину доливку", "выйду одним объёмом"), set take_profits[].size_marker="one_unit" — the executor knows the leg size, you do not. So "После усреднения твх 1.03, там буду скидывать доливку / Первый Таргет 1.048" => ONE modify_tp with two targets: {value:1.03, size_marker:"one_unit"} and {value:1.048, index:1} — and NO modify_sl at all.

TARGET LADDER: the trader announces targets one at a time ("Первый тейк по эфиру - 1943", "вторая цель 1960") or as a list ("Следующие цели 72.7, 74"). For every take_profit fill index when the author states an ordinal (первый/первая=1, второй/вторая=2, третий=3) — an ordinal stated once carries over to the elliptical lines that follow in the same message ("Первый тейк по эфиру - 1943 / По Xrp - 1.08" => index=1 for BOTH symbols). Fill fraction ONLY when the author names a share for that target ("на первой фикс 30%" => fraction=0.3); never derive a fraction from the number of targets — that arithmetic belongs to the executor. Fill tp_ladder_total only when the author says how many targets there are in total.

MULTI-SYMBOL: one message may manage several symbols ("🔄 Менеджмент позиций", "Sl btc.. Sl Eth.."). Emit one action per (symbol, intent). message_type=management_multi.

IMAGES ARE MANDATORY CONTEXT. Terse messages ("2🎯","Первые цели","Скинул один объем","Фиксану вместо первой") carry the symbol/side/price ONLY in the attached image (WEEX result card: symbol, Лонг/Шорт, leverage 10x, Цена входа, Цена маркировки; or a TradingView chart with the ticker top-left). Read the image to resolve symbol/side; set image_used=true and evidence_source="image"/"both". If symbol is still unresolved, symbol="UNKNOWN" and needs_human=true.

CONTEXT PROVIDED: the message text, its timestamp, the REPLY THREAD it belongs to (parent, then further ancestors, nearest first), and the channel's currently OPEN positions (to resolve which symbol a symbol-less delta refers to). Resolve the symbol in this order: an explicit symbol in text/image; else [reply_thread_symbol] when given (the engine read it off the thread deterministically — do not override it with a guess from OPEN_POSITIONS); else the reply thread texts, nearest ancestor first; else the open-positions list; else UNKNOWN.

REPLY THREADS ARE CHAINS. The trader runs a position as a chain of terse replies, each answering the previous one ("Sol 1🎯" <- "2🎯" <- "3🎯"): the symbol is stated ONCE, at the root of the thread, and every later reply inherits it. Never fall back to "the most recent/most prominent open position" while an ancestor in the thread names a symbol — that is how a SOL take-profit gets applied to a BTC position.

SIDE: 📈/LONG/Лонг=long, 📉/SHORT/Шорт=short. Trader here is long-biased; a bare "фикс/стоп" on an open long => side=long.

NOISE: voice-chat announcements, Zoom links, OKX/WEEX promo, pure market reviews (#BTC обзор with no order) => message_type=commentary/noise, actions=[]. Still set understood=true.

Be exhaustive: missing an action is the worst error. If unsure whether something is an action, emit it with needs_human=true rather than dropping it.`

/** Content-блоки Anthropic Messages API, которые собирает buildUserTurn. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** Одна прикреплённая картинка (base64 без data:-префикса, media_type §9 — весь дамп .jpg). */
export interface PromptImage {
  base64: string
  mediaType: string
}

/**
 * Компактная сводка открытой позиции (§4.4) — одна строка JSON-объекта на позицию в массиве
 * `OPEN_POSITIONS`. Нужна резолюции символа терсных дельт ("Стоп на твх") и различению open/add.
 */
export interface OpenPositionSummary {
  sym: string
  side: Side
  legs: number
  avgEntry: number
  /** 'BE' — стоп переведён в безубыток (§4.4 пример); число — конкретная цена; 'none' — стопа нет. */
  sl: 'BE' | number | 'none'
  tpsLeft: number[]
  /** id сообщения, открывшего сделку (опционально, для трассировки). */
  opened?: number
}

export interface BuildUserTurnParams {
  text: string
  /** ISO-таймстамп сообщения (t_msg=..., §4.2). */
  tMsg: string
  /** Текст родительского сообщения по reply, если есть. */
  replyParentText?: string
  /** Тексты предков ВЫШЕ родителя, ближайший первым (ветка терсных реплик). */
  replyChain?: string[]
  /** Символ, вычитанный из ветки самим движком (детерминированно) — сильная подсказка модели. */
  replyChainSymbol?: string
  openPositions: OpenPositionSummary[]
  images: PromptImage[]
}

/**
 * Сериализует одну позицию в порядок ключей §4.4 (sym/side/legs/avg_entry/sl/tps_left/opened).
 * Экспортирована (не только для buildUserTurn ниже): ai/context.ts (задача 2, hashOpenPositions)
 * хэширует ТУ ЖЕ каноническую форму, что здесь уходит в промпт модели — это принципиально
 * (research §10: "hash(open_positions_snapshot)" в ключе кэша обязан отражать РОВНО то, что видит
 * модель, иначе два разных промпта могут схлопнуться в один кэш-ключ или наоборот).
 */
export function serializeOpenPosition(p: OpenPositionSummary): Record<string, unknown> {
  const row: Record<string, unknown> = {
    sym: p.sym,
    side: p.side,
    legs: p.legs,
    avg_entry: p.avgEntry,
    sl: p.sl,
    tps_left: p.tpsLeft,
  }
  if (p.opened !== undefined) row.opened = p.opened
  return row
}

/**
 * Собирает content-блоки user-сообщения (research §4.2): [инструкция+cache_control] →
 * [для каждой картинки: "Image N:" + image-блок] → [контекст: t_msg, reply, OPEN_POSITIONS,
 * MESSAGE TEXT]. Картинка ДО текста (§9, рекомендация Anthropic). Кэшируемый первый блок —
 * ТОЛЬКО инструкция, без переменных данных; все переменные части — после него.
 */
export function buildUserTurn(params: BuildUserTurnParams): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [
    { type: 'text', text: EXTRACTOR_INSTRUCTION, cache_control: { type: 'ephemeral' } },
  ]

  params.images.forEach((image, index) => {
    blocks.push({ type: 'text', text: `Image ${index + 1} (attached to this message):` })
    blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } })
  })

  const contextLines: string[] = [`t_msg=${params.tMsg}`]
  if (params.replyParentText !== undefined) {
    contextLines.push(`[reply_to]: ${params.replyParentText}`)
  }
  // Ветка выше родителя — ближайший предок первым: символ терсной реплики живёт в корне ветки.
  if (params.replyChain !== undefined && params.replyChain.length > 0) {
    params.replyChain.forEach((text, index) => {
      contextLines.push(`[reply_thread +${index + 2}]: ${text}`)
    })
  }
  if (params.replyChainSymbol !== undefined) {
    contextLines.push(`[reply_thread_symbol]: ${params.replyChainSymbol}`)
  }
  const openPositionsJson = JSON.stringify(params.openPositions.map(serializeOpenPosition))
  contextLines.push(`OPEN_POSITIONS: ${openPositionsJson}`)
  contextLines.push('MESSAGE TEXT:')
  contextLines.push(params.text)

  blocks.push({ type: 'text', text: contextLines.join('\n') })
  return blocks
}
