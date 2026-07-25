// Дефолты channel_settings дословно дублировались в двух независимых сидерах —
// apps/tg-ingest/src/ingest.service.ts (сидирует при первом реальном коннекте к Telegram) и
// apps/api/src/channels/channel-seed.service.ts (сидирует без доступа к Telegram) — см. комментарий
// в channel-seed.service.ts про намеренную независимость самих сидеров: дублируется только набор
// значений по умолчанию, а не факт сидирования. channel_id и updated_at остаются на стороне вызывающего
// кода — там они разные (id канала, конкретный Date конкретного сидера).
export const DEFAULT_CHANNEL_SETTINGS = {
  enabled: false,
  trade_size: '500',
  max_leverage: '10',
  default_leverage: null,
  cross_margin: true,
  no_sl_policy: 'attach_protective_sl',
  no_sl_buffer_sec: 0,
  add_sizing_mode: 'trade_size',
  max_symbol_notional: null,
  mirror_manual_fraction: false,
  limit_ttl_sec: 604_800,
} as const

/**
 * Дефолты для ТЕСТОВОГО канала (TG_CHANNEL_OVERRIDES, см. sources.ts).
 *
 * Отличаются двумя вещами, и обе — про удобство проверки:
 *  - `enabled: true` — боевой канал заводится ВЫКЛЮЧЕННЫМ (осознанная защита: подключили канал —
 *    он не начинает торговать, пока оператор сам не включит тумблер). Но тестовый канал вы создали
 *    именно чтобы он торговал: с выключенным копированием ваш сигнал молча ушёл бы в skipped
 *    (`copy_disabled`), и вы бы полчаса искали, почему «бот не реагирует».
 *  - `trade_size: 10` USDT вместо 500 — тестовый прогон не должен занимать заметную часть депозита.
 *
 * Сидируется через ON CONFLICT DO NOTHING, поэтому НЕ затирает настройки, которые вы поменяли в UI.
 */
export const TEST_CHANNEL_SETTINGS = {
  ...DEFAULT_CHANNEL_SETTINGS,
  enabled: true,
  // 150, а не 10: размер сделки должен быть не меньше `qtyStep × цена`, иначе объём округляется
  // В НОЛЬ и вход уходит в skip('zero_qty'). У BTC шаг 0.001 → при цене ~65 000 минимум ≈ 65 USDT
  // (10/65000 = 0.00015 → floor к 0.001 → 0). На сигналах со стопом это не всплывало: там размер
  // считается по риск-формуле и получается крупным, а фиксированный trade_size — фолбэк для
  // сигналов «вход с текущих» (риска в них нет). 150 открывает BTC/SOL/ETH.
  trade_size: '150',
} as const
