// DTO, общие для API и будущего фронта (apps/web, Ф2+). Ровно как в брифе задачи 8
// (.superpowers/sdd/task-8-brief.md) — типы контракта, а не доменная модель БД.

export interface ChannelDto {
  id: number
  key: string
  title: string
  handle: string
  initial: string
  status: 'active' | 'paused' | 'error'
  copyEnabled: boolean
  winRate: string // '—' пока нет закрытых сделок
  actionCount: number
  activePositions: number
  messageCount: number
  tradeSize: string
  maxLeverage: string
}

// Заглушка на будущее (Ф1+): в брифе задачи 8 MessageDto ссылается на этот тип, но в Ф0
// actions всегда [] — реальный разбор появится вместе с actions-пайплайном. Форма выведена
// из design/project/Admin.dc.html (блок под сообщением: иконка типа + пара + ссылка на сделку)
// и action_type/side_t из apps/api/src/db/migrations/001_initial.ts.
export interface MessageActionDto {
  type: 'open' | 'add' | 'close' | 'partial_tp' | 'partial_close'
  side: 'long' | 'short' | null
  pair: string | null
  tradeRef: string | null // '#TR-xxxx' или null, если сигнал пропущен (Skipped)
  skipReason: string | null
}

export interface MessageDto {
  id: string
  tgMessageId: number
  time: string // ISO-строка msg_ts
  text: string
  media: { url: string; kind: 'photo' | 'video-thumb' }[]
  aiSummary: string | null
  actions: MessageActionDto[] // в Ф0 всегда []
  method: 'auto' | 'ai' | 'review' | null
}
