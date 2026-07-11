import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { formatWinRate } from 'shared/numbers.js'
import { DatabaseService } from '../db/database.service.js'

// Win Rate (Ф4, task-2-brief.md): доля прибыльных ЗАКРЫТЫХ сделок канала — знаменатель
// `status='closed'`, числитель `is_win`. 'cancelled' (неисполнившиеся лимитки) сознательно
// исключён обоими запросами ниже — это НЕ результат сделки, а не просто "не выигрыш".
// formatWinRate (packages/shared/src/numbers.ts) — общий с apps/engine/src/state/trades.ts
// (эмиссия 'channel.stats' при закрытии сделки) хелпер округления/пустого состояния, чтобы
// REST-ответ и WS-событие никогда не разошлись в формуле.

interface WinRateRow {
  closed_trades: string
  wins: string
}

@Injectable()
export class ChannelStatsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Win Rate одного канала — GET /channels/:id. */
  async winRateFor(channelId: number): Promise<string> {
    const { rows } = await sql<WinRateRow>`
      SELECT count(*)::text AS closed_trades, count(*) FILTER (WHERE is_win)::text AS wins
      FROM trades
      WHERE channel_id = ${channelId} AND status = 'closed'
    `.execute(this.database.db)
    const row = rows[0]
    return formatWinRate(Number(row?.closed_trades ?? 0), Number(row?.wins ?? 0))
  }

  /**
   * Win Rate ВСЕХ каналов одним запросом — GET /channels (listChannels), не N+1 по каналам
   * (тот же принцип, что и корреллированные подзапросы CHANNEL_COLUMNS в channels.service.ts,
   * только агрегация тут сгруппирована явно, а не подзапросом на строку). Канал без единой
   * закрытой сделки просто отсутствует в результате — вызывающий код обязан подставлять
   * formatWinRate(0, 0) ('—') для таких id по умолчанию (см. channels.service.ts::toChannelDto).
   */
  async winRatesForAll(): Promise<Map<number, string>> {
    const { rows } = await sql<{ channel_id: number; closed_trades: string; wins: string }>`
      SELECT channel_id, count(*)::text AS closed_trades, count(*) FILTER (WHERE is_win)::text AS wins
      FROM trades
      WHERE status = 'closed'
      GROUP BY channel_id
    `.execute(this.database.db)

    const map = new Map<number, string>()
    for (const row of rows) {
      map.set(Number(row.channel_id), formatWinRate(Number(row.closed_trades), Number(row.wins)))
    }
    return map
  }
}
