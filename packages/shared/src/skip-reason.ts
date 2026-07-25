// Человекочитаемые подписи причин, по которым действие не было исполнено.
//
// Раньше причина жила ТОЛЬКО в атрибуте title (всплывающая подсказка), а на экране был безликий
// бейдж «Skipped». Оператор видел, что бот что-то не сделал, но не понимал почему — и не мог
// отличить «сигнал без стопа» от «символа нет на бирже» или «канал выключен», не наводя мышь на
// каждую строку. Причина — самое важное в пропущенном действии, поэтому она выводится текстом.
//
// Общий модуль (а не копия в apps/web): те же подписи нужны и таймлайну канала, и странице Actions.

/** Сырые значения skip_reason, которые ставят pipeline.ts / reconciler.ts / normalize-output.ts. */
const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  // ── Гейты риска и рынка ────────────────────────────────────────────────────────────────────
  no_SL: 'no stop-loss',
  unsafe_stop: 'unsafe stop',
  invalid_sl_side: 'stop on the wrong side of entry',
  price_slippage: 'price moved away from the signal',
  mark_price_unavailable: 'no market price',
  zero_qty: 'zero size after rounding',
  min_notional: 'size below exchange minimum',
  max_symbol_notional: 'symbol exposure limit exceeded',

  // ── Символ ────────────────────────────────────────────────────────────────────────────────
  symbol_not_listed: 'symbol not listed on the exchange',
  symbol_unknown: 'symbol not recognised',
  symbol_unresolved: 'symbol could not be resolved',
  symbol_busy: 'symbol already has an open trade',

  // ── Состояние сделки ──────────────────────────────────────────────────────────────────────
  no_open_position: 'no open position',
  incomplete_signal: 'incomplete signal',
  not_implemented_phase1: 'signal type not supported yet',
  // «Стоп в безубыток», когда позиция ушла в минус: безубыток оказывается по ту сторону рынка
  // (для лонга — выше текущей цены). Биржа такой стоп отвергает — это не сбой, а рынок.
  sl_beyond_market: 'stop beyond market — position in loss',
  unsafe_leverage: 'leverage too high for a protective stop',

  // ── Настройки и ручное управление ─────────────────────────────────────────────────────────
  copy_disabled: 'copy trading disabled for the channel',
  manual_override: 'trade under manual control',

  // ── Исходы AI/реконсилера (показываются как Needs review) ──────────────────────────────────
  ai_unavailable: 'AI unavailable',
  low_confidence: 'AI is not confident in the parse',
  needs_human: 'AI asks for manual review',
  parser_disagreement: 'template and AI disagree',
  symbol_unknown_needs_vision: 'AI could not identify the symbol',
  ai_unresolved_marker: 'AI could not resolve the symbol marker',
  unknown_format: 'unfamiliar message format',
}

/**
 * Отказ биржи по существу (`exchange_rejected_<retCode>`): сообщение уводится в needs_review, а не
 * переигрывается вечно (см. main.ts). Код Bybit оставляем в подписи — по нему оператор найдёт причину.
 */
const EXCHANGE_REJECTED_PREFIX = 'exchange_rejected_'

/**
 * Подпись причины для человека. Неизвестная причина возвращается как есть (сырым кодом) — это
 * честнее, чем скрыть её за «неизвестной ошибкой»: оператор увидит хотя бы код и сможет спросить.
 */
export function skipReasonLabel(reason: string): string {
  if (reason.startsWith(EXCHANGE_REJECTED_PREFIX)) {
    return `exchange rejected (code ${reason.slice(EXCHANGE_REJECTED_PREFIX.length)})`
  }
  return SKIP_REASON_LABELS[reason] ?? reason
}
