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
  /** Канал подставлен через TG_CHANNEL_OVERRIDES (тестовый режим) — сидируется с включённым
   *  копированием и малым trade_size, см. TEST_CHANNEL_SETTINGS. */
  readonly isTest?: boolean
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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ТЕСТОВЫЙ РЕЖИМ: подмена каналов-источников своими (TG_CHANNEL_OVERRIDES)
//
// Зачем: боевые каналы постят 2-8 сообщений в день, и ждать живой сигнал ради проверки пайплайна
// бессмысленно. Оверрайд подставляет вместо них ВАШИ каналы/группы, куда вы сами пишете сигналы —
// весь путь (Telegram → разбор → риск → ордер на бирже) остаётся настоящим.
//
// ⚠️ Оверрайд ЗАМЕЩАЕТ список целиком: боевые каналы при этом НЕ слушаются. Это сделано намеренно —
// иначе живой сигнал из боевого канала открыл бы реальную сделку прямо посреди вашего теста.
//
// Формат (через запятую): <ord>=<tg_id>[:<topic_id>]
//   TG_CHANNEL_OVERRIDES=1=2999999999,2=2888888888
//   TG_CHANNEL_OVERRIDES=1=2999999999,2=2888888888:173666   ← если ваш второй источник — форум-топик
// `ord` — номер боевого канала из CHANNEL_SOURCES выше (1 = ch1-structured, 2 = ch2-freeform).
// От боевого канала наследуется adapterId — то есть подменённый канал разбирается ТЕМ ЖЕ парсером.
// `tg_id` — «сырой» id канала, БЕЗ префикса -100 (узнать: `pnpm tg:chats`).
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Смещение ord у тестовых каналов: строки боевых каналов остаются в БД со своей историей,
 *  а `channels.ord` UNIQUE — без смещения INSERT тестового канала конфликтовал бы с боевым. */
const OVERRIDE_ORD_OFFSET = 100

export interface ChannelOverride {
  ord: number
  channelId: bigint
  topicId: number | null
}

/**
 * Разбирает TG_CHANNEL_OVERRIDES. Пусто/не задано → пустой список (боевой режим).
 * Формат строгий: любая опечатка — исключение, а не тихое игнорирование. Молча слушать боевой
 * канал вместо тестового опаснее, чем упасть на старте.
 */
export function parseChannelOverrides(raw: string | undefined): ChannelOverride[] {
  if (!raw || raw.trim().length === 0) return []

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry): ChannelOverride => {
      const [ordPart, target] = entry.split('=')
      if (!ordPart || !target) {
        throw new Error(`TG_CHANNEL_OVERRIDES: ожидался формат <ord>=<tg_id>[:<topic_id>], получено "${entry}"`)
      }

      const ord = Number(ordPart.trim())
      const base = CHANNEL_SOURCES.find((s) => s.ord === ord)
      if (!base) {
        const known = CHANNEL_SOURCES.map((s) => `${s.ord} (${s.adapterId})`).join(', ')
        throw new Error(`TG_CHANNEL_OVERRIDES: нет канала с ord=${ordPart.trim()}. Доступны: ${known}`)
      }

      const [idPart, topicPart] = target.trim().split(':')
      const channelId = BigInt(String(idPart).trim())
      if (channelId <= 0n) {
        throw new Error(`TG_CHANNEL_OVERRIDES: id канала должен быть положительным «сырым» id без -100, получено "${idPart}"`)
      }

      const topicId = topicPart !== undefined && topicPart.trim().length > 0 ? Number(topicPart.trim()) : null
      if (topicId !== null && !Number.isInteger(topicId)) {
        throw new Error(`TG_CHANNEL_OVERRIDES: topic_id должен быть целым числом, получено "${topicPart}"`)
      }

      return { ord, channelId, topicId }
    })
}

/**
 * Итоговый список каналов-источников: боевой по умолчанию, ваш — если задан TG_CHANNEL_OVERRIDES.
 * Единственная точка правды для tg-ingest (кого слушать) и api (кого сидировать в channels).
 */
export function resolveChannelSources(env: { TG_CHANNEL_OVERRIDES?: string | undefined }): readonly ChannelSource[] {
  const overrides = parseChannelOverrides(env.TG_CHANNEL_OVERRIDES)
  if (overrides.length === 0) return CHANNEL_SOURCES

  return overrides.map((override): ChannelSource => {
    const base = CHANNEL_SOURCES.find((s) => s.ord === override.ord)!
    const topicId = override.topicId
    return {
      channelId: override.channelId,
      // Свой key: он UNIQUE и служит именем папки медиа — медиа тестового канала не должно
      // смешиваться с боевым.
      key: topicId != null ? `test-${override.channelId}-t${topicId}` : `test-${override.channelId}`,
      ord: base.ord + OVERRIDE_ORD_OFFSET,
      topicId,
      // Главное: подменённый канал разбирается ТЕМ ЖЕ адаптером, что и боевой, который он заменяет.
      adapterId: base.adapterId,
      sourceKind: topicId != null ? 'forum_topic' : 'channel',
      isTest: true,
    }
  })
}
