// Доменные типы, общие для api и будущего engine (Ф1+). Пока единственный тип — Instrument
// (задача 1: кэш instruments-info + risk-limit, см. apps/api/src/instruments/instruments.service.ts),
// сюда же по мере задач Ф1 добавятся Action/Trade/Order и т.п.

export type Network = 'testnet' | 'mainnet'

/**
 * Строка кэша инструментов Bybit (таблица `instruments`, apps/api/src/db/migrations/001_initial.ts
 * + 003_instruments_mmr.ts). Гейт торговли — `status === 'Trading'`. Денежные/шаговые поля —
 * строки (NUMERIC из Postgres), не number: округления qty/price делаются Decimal-арифметикой
 * в engine, а не float.
 */
export interface Instrument {
  symbol: string
  network: Network
  baseCoin: string
  status: string
  qtyStep: string
  minQty: string
  tickSize: string
  minNotional: string
  maxLeverage: string
  leverageStep: string
  // MMR (maintenance margin rate) risk-limit tier1. null — если Bybit не отдал risk-limit
  // тиры для символа на этой сети (напр. делистнутый инструмент, retCode=10001).
  mmr: string | null
  refreshedAt: string // ISO
}

// Типы адаптера канала (задача 3, research §10 «Интерфейс адаптера»). Перенесены
// дословно из docs/superpowers/research/channel-adapters.md §10 — единственный
// контракт между ядром и адаптером конкретного Telegram-канала: ядро передаёт
// ParseContext, адаптер возвращает ParsedResult, ничего не зная про Bybit/БД/сеть.

export type Side = 'long' | 'short'

/** execute = детерминированно исполняем; ai = нужен LLM+state (Ф2); skip/noise — не исполняем. */
export type Route = 'execute' | 'ai' | 'skip' | 'noise'

export interface ParseContext {
  channelId: string
  message: {
    id: number
    text: string
    date: string
    replyToMsgId: number | null
    groupedId: string | null
    media: string | null
    mediaFile: string | null
  }
  // разрешение символа + reply/state, ядро передаёт, адаптер не знает про Bybit:
  resolveSymbol(raw: string): string | null // алиас → BYBITSYMBOL (или null)
  isListed(symbol: string): boolean // instruments-info кэш активной сети
  getMessage(id: number): ParseContext['message'] | null // для транзитивного reply-подъёма
  // state «один символ — один канал»:
  openPositions: ReadonlyMap<string, { tradeId: string; side: Side; openedByChannel: string }>
  lastTouchedSymbol: string | null // для символ-less дельт CH2
}

export type ParsedIntent =
  | {
      kind: 'entry_signal'
      symbol: string
      side: Side
      entry: [number, number] | number
      tps: number[]
      sl: number
      riskPct?: number
    } // R1 / A
  | { kind: 'limit_entry'; symbol: string; side: Side; price: number } // B
  | { kind: 'market_entry'; symbol: string; side: Side } // C
  | { kind: 'add'; symbol: string; price?: number } // доливка (реш. #6)
  | { kind: 'delta'; symbol: string | null; ops: DeltaOp[]; targetTradeId?: string } // R3/R4/D/E

// Ф2 (задача 2, normalize-output.ts) добавила 3 варианта поверх Ф1-набора — AI-канал (CH2)
// покрывает case'ы, которых нет у детерминированного CH1: «скинул один объём» (единица объёма,
// не доля — value НЕ вычисляем здесь, реальное qty подставит пайплайн, задача 4), явную
// AI-лесенку новых TP-целей (modify_tp) и отмену ЕЩЁ НЕ исполненного лимитного входа/добора
// (cancel_order на pending-ордер — семантически ДРУГОЕ действие, чем sl_cancel, который снимает
// уже выставленный стоп; смешивать их пайплайн (task-7-brief.md handleDelta ищет purpose='sl')
// нельзя — привело бы к попытке отменить SL вместо висящего лимитника).
export type DeltaOp =
  | { op: 'tp_hit'; index?: number }
  // unit:'one_unit' — «скинул один объём»/«закрыл один объём» (research/ai-layer.md §3): AI НЕ
  // считает, какая это доля — единицу объёма (одну добор-легу) находит пайплайн по состоянию
  // сделки. basis — origin CloseAmountSpec.basis ('original'|'remaining'), 'unknown' не сохраняем
  // (эквивалентно отсутствию поля — решение пайплайна по умолчанию).
  | { op: 'partial_close'; fraction?: number; unit?: 'one_unit'; basis?: 'original' | 'remaining' }
  | { op: 'close_remainder' }
  | { op: 'sl_breakeven' }
  | { op: 'sl_hit' }
  | { op: 'sl_set'; price: number }
  | { op: 'sl_cancel' }
  // Новые цели TP (modify_tp) — каждая цель либо число, либо символьный маркер 'current_price'
  // (LLM не считает арифметику, research §3/§10) — value/marker взаимоисключающие, оба опциональны.
  | { op: 'tp_set'; targets: Array<{ value?: number; marker?: 'current_price' }> }
  // cancel_order (extract_signal.actions[].type) — отмена ЕЩЁ НЕ исполненного pending-ордера
  // (лимитный вход/добор), НЕ путать с sl_cancel (снятие уже выставленного стоп-лосса).
  | { op: 'cancel_pending' }
  | { op: 'hold' }

export interface ParsedResult {
  route: Route
  confidence: number // [0,1]
  intents: ParsedIntent[] // >1 при мульти-ордер/мульти-mgmt (E2/E4)
  reason?: string // 'no_SL' | 'symbol_not_listed' | 'symbol_unknown_needs_vision'
  needsVision?: boolean // CH2: символ только в mediaFile
}

// Типы состояния сделки (задача 5, `apps/engine/src/state/trades.ts` + БД-типы
// apps/api/src/db/database.ts) — дословно enum'ы из миграции 001_initial.ts
// (trade_status/leg_kind/leg_status). Единый источник правды для api и engine —
// не дублировать строковые union'ы в обоих местах (DRY).
export type TradeStatus = 'pending' | 'open' | 'partially_closed' | 'closed' | 'cancelled' | 'skipped'
export type LegKind = 'entry' | 'add'
export type LegStatus = 'pending' | 'working' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected'

// Типы состояния ордеров/исполнений (задача 6, `apps/engine/src/execution/*`) — дословно
// enum'ы из миграции 001_initial.ts (order_purpose/order_type_t/order_status). Единый источник
// правды для api (apps/api/src/db/database.ts) и engine (execution/order-link-id.ts,
// execution/port.ts) — та же причина, что у TradeStatus/LegKind/LegStatus выше.
export type OrderPurpose = 'entry' | 'add' | 'tp' | 'sl' | 'close' | 'cancel'
export type OrderType = 'market' | 'limit'
export type OrderStatus =
  | 'created'
  | 'pending_submit'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'expired'

// Типы плоского слоя actions (задача 7: reconciler/pipeline, apps/engine/src/reconciler.ts +
// pipeline.ts) — дословно enum'ы action_type/action_status из миграции 001_initial.ts. Тот же
// приём DRY, что и у Order*/Trade*-типов выше: apps/api/src/db/database.ts (actions.type/status)
// и engine делят один источник правды вместо дублирования строковых union'ов.
export type ActionType =
  | 'open'
  | 'add'
  | 'close'
  | 'partial_tp'
  | 'partial_close'
  | 'modify_sl'
  | 'modify_tp'
  | 'cancel_order'
  | 'tp_hit'
  | 'sl_hit'
  | 'close_all'
  | 'hold'
export type ActionStatus = 'pending' | 'executing' | 'executed' | 'skipped' | 'needs_review' | 'failed'

/** `parser_kind` из миграции — кто произвёл `parse_results` (в Ф1 всегда 'deterministic'). */
export type ParserKind = 'deterministic' | 'ai'
