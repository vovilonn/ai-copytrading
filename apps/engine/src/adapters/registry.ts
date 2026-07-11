import type { ParseContext, ParsedResult } from 'shared/domain.js'
import { parseCh1 } from './ch1.adapter.js'
import { parseCh2 } from './ch2.adapter.js'

/** Единственный контракт между ядром и адаптером конкретного Telegram-канала (research §10). */
export interface ChannelAdapter {
  readonly id: string
  parse(ctx: ParseContext): ParsedResult
}

const ch1Adapter: ChannelAdapter = {
  id: 'ch1-structured',
  parse: parseCh1,
}

// Канал CH2 (форум 1962583820, свободный формат) — задача 3 Ф2: детерминированные правила
// A-D (structured signal, limit_entry, market_entry, delta_sl с тикером) + маршрут E/F в AI
// для символ-less дельт и свободного текста (research §0/§2).
const ch2Adapter: ChannelAdapter = {
  id: 'ch2-freeform',
  parse: parseCh2,
}

const registry = new Map<string, ChannelAdapter>([
  [ch1Adapter.id, ch1Adapter],
  [ch2Adapter.id, ch2Adapter],
])

export function getAdapter(adapterId: string): ChannelAdapter {
  const adapter = registry.get(adapterId)
  if (!adapter) throw new Error(`Неизвестный адаптер канала: ${adapterId}`)
  return adapter
}
