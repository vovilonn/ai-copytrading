import type { ParseContext, ParsedResult } from 'shared/domain.js'
import { parseCh1 } from './ch1.adapter.js'

/** Единственный контракт между ядром и адаптером конкретного Telegram-канала (research §10). */
export interface ChannelAdapter {
  readonly id: string
  parse(ctx: ParseContext): ParsedResult
}

const ch1Adapter: ChannelAdapter = {
  id: 'ch1-structured',
  parse: parseCh1,
}

// Заглушка канала CH2 (форум, свободный формат) — реализация в фазе 2.
// Всегда уходит в AI-роут: у CH2 половина actionable-сообщений не имеет
// символа в тексте (research §0/§2), детерминированный парсинг не покрывает их.
const ch2Stub: ChannelAdapter = {
  id: 'ch2-freeform',
  parse: () => ({ route: 'ai', confidence: 0.5, intents: [] }),
}

const registry = new Map<string, ChannelAdapter>([
  [ch1Adapter.id, ch1Adapter],
  [ch2Stub.id, ch2Stub],
])

export function getAdapter(adapterId: string): ChannelAdapter {
  const adapter = registry.get(adapterId)
  if (!adapter) throw new Error(`Неизвестный адаптер канала: ${adapterId}`)
  return adapter
}
