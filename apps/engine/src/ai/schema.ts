// Схема tool-вывода `extract_signal` (research/ai-layer.md §3, ПЕРЕНЕСЕНО ДОСЛОВНО — состав
// полей/enum'ов/required не менять произвольно, это форсируемый инструмент прокси, проверенный
// на 460 живых вызовах с 0 отказов). Схема — часть кэшируемого prefix (§10: `tools`+CC-система+
// инструкция ≈ 4841 ток), поэтому сериализация должна быть детерминированной: НЕ добавлять сюда
// дату/uuid/что-либо переменное.

/** `message_type` — категория сообщения целиком (§3). */
export type MessageType =
  | 'entry'
  | 'add_to_position'
  | 'close'
  | 'close_partial'
  | 'modify_sl'
  | 'modify_tp'
  | 'cancel_order'
  | 'position_event'
  | 'management_multi'
  | 'commentary'
  | 'noise'

/** `actions[].type` — тип одного извлечённого действия. */
export type ExtractedActionType =
  | 'open'
  | 'add'
  | 'close'
  | 'modify_sl'
  | 'modify_tp'
  | 'cancel_order'
  | 'tp_hit'
  | 'sl_hit'

export type ExtractedSide = 'long' | 'short' | 'unknown'
export type ExtractedOrderType = 'market' | 'limit' | 'range' | 'na'
export type PriceMarker = 'current_price' | 'entry_price' | 'none'
export type EvidenceSource = 'text' | 'image' | 'both'

export interface EntrySpec {
  mode: 'market' | 'price' | 'range' | 'marker' | 'na'
  price?: number | null
  low?: number | null
  high?: number | null
  marker?: PriceMarker
}

export interface StopLossSpec {
  mode: 'price' | 'marker' | 'remove' | 'na'
  value?: number | null
  marker?: 'entry_price' | 'none'
}

export interface TakeProfitSpec {
  value?: number | null
  index?: number | null
  marker?: 'none' | 'current_price'
}

export interface CloseAmountSpec {
  mode: 'fraction' | 'units' | 'all' | 'marker' | 'na'
  value?: number | null
  basis?: 'original' | 'remaining' | 'unknown'
  marker?: 'one_unit' | 'none'
}

/** Отдельное поле `price` на действии (management-контекст) — сиблинг `entry`, не дубль. */
export interface ActionPriceSpec {
  mode: 'market' | 'price' | 'marker' | 'na'
  value?: number | null
  marker?: PriceMarker
}

export interface ExtractSignalAction {
  type: ExtractedActionType
  symbol: string // normalized BASEUSDT; UNKNOWN if unresolved
  side: ExtractedSide
  order_type?: ExtractedOrderType
  entry?: EntrySpec
  stop_loss?: StopLossSpec
  take_profits?: TakeProfitSpec[]
  tp_index?: number | null
  close_amount?: CloseAmountSpec
  price?: ActionPriceSpec
  risk_pct?: number | null
  leverage?: number | null
  evidence_source: EvidenceSource
  evidence?: string
}

/** Тип, соответствующий `output_schema` инструмента `extract_signal` (§3). */
export interface ExtractSignalOutput {
  understood: boolean
  needs_human: boolean
  message_type: MessageType
  image_used: boolean
  confidence: number
  summary: string
  actions: ExtractSignalAction[]
}

/**
 * Tool-спецификация для forced `tool_choice:{type:'tool',name:'extract_signal'}` (research §3,
 * дословно). Идёт в поле `tools` запроса к ai-proxy — НЕ дублируется текстом в user-turn
 * (буквенное описание схемы уже покрыто инструкцией §4.1, см. prompt.ts).
 */
export const EXTRACT_SIGNAL_TOOL = {
  name: 'extract_signal',
  description:
    "Extract every executable trading action from a Telegram trading message (text+images). One action object per action. NEVER compute arithmetic: any price/qty to be derived (breakeven, avg entry, 'current price', 'one unit') is a symbolic marker, not a number.",
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['understood', 'needs_human', 'message_type', 'image_used', 'confidence', 'summary', 'actions'],
    properties: {
      understood: { type: 'boolean' },
      needs_human: { type: 'boolean' },
      message_type: {
        type: 'string',
        enum: [
          'entry',
          'add_to_position',
          'close',
          'close_partial',
          'modify_sl',
          'modify_tp',
          'cancel_order',
          'position_event',
          'management_multi',
          'commentary',
          'noise',
        ],
      },
      image_used: { type: 'boolean' },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'symbol', 'side', 'evidence_source'],
          properties: {
            type: {
              type: 'string',
              enum: ['open', 'add', 'close', 'modify_sl', 'modify_tp', 'cancel_order', 'tp_hit', 'sl_hit'],
            },
            symbol: { type: 'string', description: 'normalized BASEUSDT; UNKNOWN if unresolved' },
            side: { type: 'string', enum: ['long', 'short', 'unknown'] },
            order_type: { type: 'string', enum: ['market', 'limit', 'range', 'na'] },
            entry: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['market', 'price', 'range', 'marker', 'na'] },
                price: { type: ['number', 'null'] },
                low: { type: ['number', 'null'] },
                high: { type: ['number', 'null'] },
                marker: { type: 'string', enum: ['current_price', 'entry_price', 'none'] },
              },
            },
            stop_loss: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['price', 'marker', 'remove', 'na'] },
                value: { type: ['number', 'null'] },
                marker: { type: 'string', enum: ['entry_price', 'none'] },
              },
            },
            take_profits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  value: { type: ['number', 'null'] },
                  index: { type: ['integer', 'null'] },
                  marker: { type: 'string', enum: ['none', 'current_price'] },
                },
              },
            },
            tp_index: { type: ['integer', 'null'] },
            close_amount: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['fraction', 'units', 'all', 'marker', 'na'] },
                value: { type: ['number', 'null'] },
                basis: { type: 'string', enum: ['original', 'remaining', 'unknown'] },
                marker: { type: 'string', enum: ['one_unit', 'none'] },
              },
            },
            price: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', enum: ['market', 'price', 'marker', 'na'] },
                value: { type: ['number', 'null'] },
                marker: { type: 'string', enum: ['current_price', 'entry_price', 'none'] },
              },
            },
            risk_pct: { type: ['number', 'null'] },
            leverage: { type: ['number', 'null'] },
            evidence_source: { type: 'string', enum: ['text', 'image', 'both'] },
            evidence: { type: 'string' },
          },
        },
      },
    },
  },
} as const
