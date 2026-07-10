// Единый источник правды для списка каналов-источников Ф0. Раньше был продублирован в
// apps/tg-ingest/src/sources.ts (резолв Telegram-сущностей) и apps/api/src/channels/channel-seed.service.ts
// (сид channels/channel_settings в БД без доступа к Telegram) — оба потребителя импортируют
// CHANNEL_SOURCES отсюда.
//
// channelId — «сырой» id канала Telegram (тот же вид, что и channels.id в БД — BIGINT,
// читается Kysely как number, см. apps/api/src/db/database.ts). Храним как bigint здесь,
// потребители сами конвертируют в number там, где это нужно (DB/DTO не тянут bigint).
//
// topicId=null → обычный канал, весь трафик в зоне ответственности; topicId задан → форум,
// и в зону ответственности попадает только этот топик (фильтр — topicOf в topic-filter.ts).
export interface ChannelSource {
  readonly channelId: bigint
  readonly key: string
  readonly ord: number
  readonly topicId: number | null
  readonly adapterId: string
  readonly sourceKind: 'channel' | 'forum_topic'
}

export const CHANNEL_SOURCES: readonly ChannelSource[] = [
  {
    channelId: 2088626562n,
    key: 'ch-2088626562',
    ord: 1,
    topicId: null,
    adapterId: 'ch1-structured',
    sourceKind: 'channel',
  },
  {
    channelId: 1962583820n,
    key: 'ch-1962583820-t173666',
    ord: 2,
    topicId: 173666,
    adapterId: 'ch2-freeform',
    sourceKind: 'forum_topic',
  },
] as const
