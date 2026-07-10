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
