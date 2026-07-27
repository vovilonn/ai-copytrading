import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { BybitRestClient } from 'engine/bybit/rest-client.js'
import { applyTestProfile, purgeChannel, setCursor, type PurgeSummary, type TestProfile } from './db.js'
import { flatten } from './exchange.js'
import type { TgPoster } from './tg.js'
import type { E2eConfig } from './env.js'

/**
 * Чистый лист перед прогоном. Три независимых действия, и каждое лечит свою болезнь:
 *
 *  1. БИРЖА — выравнивание в ноль. Иначе позиция прошлого сценария живёт дальше и портит
 *     ожидания следующего (и просто копит риск на аккаунте).
 *  2. БД — чистка строк тестового канала. Главное здесь не «красота отчёта», а symbol_ownership:
 *     незакрытая сделка держит символ за каналом, и следующий вход по нему уйдёт в
 *     skipped(symbol_busy).
 *  3. КУРСОР — сдвиг last_seen_message_id на последнее сообщение канала В TELEGRAM. Это самая
 *     опасная деталь: очистив messages, но не сдвинув курсор, мы заставляем tg-ingest при
 *     ближайшем бэкфилле переиграть ВСЮ историю тестового канала — старые сигналы снова станут
 *     реальными ордерами.
 */

export interface ResetOptions {
  profile: TestProfile
  /** Выравнивать позиции/ордера на бирже (по умолчанию да). */
  flattenExchange?: boolean
}

export interface ChannelResetReport {
  slot: number
  channelId: number
  title: string
  purged: PurgeSummary
  cursorFrom: number
  cursorTo: number
}

export interface ResetReport {
  flattened: { closed: string[]; leftovers: string[] } | null
  channels: ChannelResetReport[]
}

export const DEFAULT_TEST_PROFILE: TestProfile = {
  enabled: true,
  // trade_size — МАРЖА на сделку (фолбэк для входов без риска в сигнале, «с текущих»), см.
  // sizing.ts: размер позиции = маржа × плечо. 30 × 10 = 300 — ровно потолок ниже, поэтому
  // прогон предсказуемо открывает позиции на 300 USDT независимо от плеча конкретного сигнала.
  tradeSize: '30',
  maxLeverage: '10',
  // Потолок экспозиции на символ: без него «риск 2%» на equity ~50k demo даёт ~20 000 USDT.
  maxSymbolNotional: '300',
  noSlPolicy: 'attach_protective_sl',
}

export async function reset(
  deps: { config: E2eConfig; db: Kysely<DB>; rest: BybitRestClient; poster: TgPoster },
  options: ResetOptions,
): Promise<ResetReport> {
  const report: ResetReport = { flattened: null, channels: [] }

  if (options.flattenExchange !== false) {
    const result = await flatten(deps.rest)
    report.flattened = {
      closed: result.closed.map((c) => `${c.symbol} ${c.side} ${c.size}`),
      leftovers: result.leftovers,
    }
  }

  // Одно соединение с Telegram на весь сброс: пока клиент e2e подключён, tg-ingest не получает
  // realtime-обновления (см. tg.ts) — окно держим минимальным.
  await deps.poster.withConnection(async () => {
    for (const channel of deps.config.channels) {
      const before = await deps.db
        .selectFrom('channels')
        .select(['last_seen_message_id', 'title', 'ord'])
        .where('id', '=', channel.id)
        .executeTakeFirst()
      // ord берём из БД (а не пересчитываем из слота): именно он попадает в orderLinkId движка,
      // по префиксу которого чистка сносит «осиротевшие» исполнения.
      const purged = await purgeChannel(deps.db, channel.id, before?.ord)
      const lastId = await deps.poster.lastMessageId(channel.slot)
      await setCursor(deps.db, channel.id, lastId)
      await applyTestProfile(deps.db, channel.id, options.profile)

      report.channels.push({
        slot: channel.slot,
        channelId: channel.id,
        title: before?.title ?? channel.key,
        purged,
        cursorFrom: Number(before?.last_seen_message_id ?? 0),
        cursorTo: lastId,
      })
    }
  })

  return report
}
