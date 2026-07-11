import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import { emitPositionUpsert } from '../pipeline.js'
import { computeUnrealisedPnl } from './pnl.js'

/**
 * Символы, для которых сейчас есть хотя бы одна открытая позиция (size<>0) — набор, на который
 * TickersFeed (task-10-brief.md) должен быть подписан на публичном `tickers.<symbol>`. Один
 * символ может встречаться в НЕСКОЛЬКИХ строках positions одновременно (решение #1 "субаккаунт
 * на канал" — PK positions это (channel_id, symbol), разные каналы держат один symbol независимо),
 * поэтому здесь именно DISTINCT, а не count.
 */
export async function openPositionSymbols(db: Kysely<DB>): Promise<string[]> {
  const rows = await db
    .selectFrom('positions')
    .select('symbol')
    .distinct()
    .where(sql<boolean>`size <> 0`)
    .execute()
  return rows.map((r) => r.symbol)
}

/**
 * Применяет живой markPrice ко ВСЕМ открытым позициям этого символа сразу (across каналов —
 * см. комментарий выше). На каждую строку: считает unrealised_pnl на Decimal (pnl.ts), пишет
 * mark_price/unrealised_pnl и публикует position.upsert ТЕМ ЖЕ путём, что и исполнение сделок
 * (emitPositionUpsert из pipeline.ts — единый формат payload для realtime, ф1 узкий: channelId/
 * symbol/side/size/avgPrice/markPrice/leverage/stopLoss/tradeId).
 *
 * Троттлинг "не чаще ~1/сек на символ" (задача 10) — забота ВЫЗЫВАЮЩЕЙ стороны (TickersFeed):
 * здесь всегда безусловное применение одного тика, чтобы функцию можно было тестировать/дёргать
 * напрямую без часов реального времени.
 *
 * @returns true, если была обновлена хотя бы одна строка (нужен ли `pg_notify('domain_events')`).
 */
export async function applyMarkPriceTick(db: Kysely<DB>, symbol: string, markPrice: string): Promise<boolean> {
  const rows = await db
    .selectFrom('positions')
    .select(['channel_id', 'side', 'size', 'avg_price'])
    .where('symbol', '=', symbol)
    .where(sql<boolean>`size <> 0`)
    .execute()
  if (rows.length === 0) return false

  for (const row of rows) {
    // Защитно: size<>0 в Ф1 всегда приходит вместе с side/avg_price (единственный писатель —
    // DryRunAdapter.placeEntry, см. dry-run.adapter.ts) — но colonки nullable в схеме, поэтому
    // не считаем PnL для гипотетически противоречивой строки вместо падения на всю пачку.
    if (row.side === null || row.avg_price === null) continue

    const pnl = computeUnrealisedPnl(row.side, row.size, row.avg_price, markPrice)

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('positions')
        .set({ mark_price: markPrice, unrealised_pnl: pnl.toString(), updated_at: new Date() })
        .where('channel_id', '=', row.channel_id)
        .where('symbol', '=', symbol)
        .execute()
      await emitPositionUpsert(trx, row.channel_id, symbol)
    })
  }

  return true
}
