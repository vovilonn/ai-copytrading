// Источники сигналов Ф0. channelId — «сырой» id канала Telegram (тот же вид, что и
// channels.id в БД — BIGINT, читается Kysely как number, см. apps/api/src/db/database.ts).
// topicId=null → обычный канал, весь трафик в зоне ответственности; topicId задан →
// форум, и в зону ответственности попадает только этот топик (фильтр — topicOf в topic-filter.ts).
export const SOURCES = [
  { channelId: 2088626562n, key: 'ch-2088626562', topicId: null, adapterId: 'ch1-structured' },
  { channelId: 1962583820n, key: 'ch-1962583820-t173666', topicId: 173666, adapterId: 'ch2-freeform' },
] as const

export type Source = (typeof SOURCES)[number]
