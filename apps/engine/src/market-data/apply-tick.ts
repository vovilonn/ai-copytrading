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

export interface ApplyTickOptions {
  /**
   * Публиковать ли `position.upsert` в `domain_events` на этот тик (task-11-brief.md, полировка Б).
   * `positions.mark_price`/`unrealised_pnl` в БД обновляются ВСЕГДА (дёшево — один UPDATE на
   * строку), а вот WS-событие — по решению вызывающей стороны: outbox api рассылает КАЖДУЮ
   * неопубликованную строку domain_events почти немедленно (NOTIFY-driven, см.
   * apps/api/src/realtime/outbox.publisher.ts), поэтому именно здесь, а не на фронте, нужно
   * решать, нужен ли ещё один пакет в WS. TickersFeed троттлит это ~раз в 2с на символ; прямые
   * вызовы (тесты, гипотетические будущие использования) по умолчанию публикуют, как раньше.
   */
  emit?: boolean
}

/**
 * Применяет живой markPrice ко ВСЕМ открытым позициям этого символа сразу (across каналов —
 * см. комментарий выше). На каждую строку: считает unrealised_pnl на Decimal (pnl.ts), пишет
 * mark_price/unrealised_pnl и (если opts.emit !== false) публикует position.upsert ТЕМ ЖЕ путём,
 * что и исполнение сделок (emitPositionUpsert из pipeline.ts — единый формат payload для realtime,
 * ф1 узкий: channelId/symbol/side/size/avgPrice/markPrice/leverage/stopLoss/tradeId).
 *
 * Троттлинг "не чаще ~1/сек на символ" ДО вызова этой функции (задача 10) и троттлинг эмита
 * position.upsert ~раз в 2с (задача 11, полировка Б) — забота ВЫЗЫВАЮЩЕЙ стороны (TickersFeed):
 * здесь всегда безусловное применение одного тика (кроме собственно emit-флага), чтобы функцию
 * можно было тестировать/дёргать напрямую без часов реального времени.
 *
 * @returns true, если строки обновлены И событие реально опубликовано (нужен ли `pg_notify`);
 *   false и при отсутствии открытых позиций по символу, и при `opts.emit === false`.
 */
export async function applyMarkPriceTick(
  db: Kysely<DB>,
  symbol: string,
  markPrice: string,
  opts: ApplyTickOptions = {},
): Promise<boolean> {
  const emit = opts.emit ?? true
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
      // `size <> 0` в WHERE UPDATE, а не только в исходном SELECT выше: позиция могла закрыться
      // (size обнулиться другой транзакцией — close_remainder/sl_hit из pipeline.ts) как раз в
      // окне между SELECT и этим UPDATE. Без этого гейта UPDATE молча перезаписал бы mark_price/
      // unrealised_pnl уже закрытой строки устаревшим ненулевым PnL. emitPositionUpsert ниже
      // перечитывает актуальную строку заново, так что на итоговый payload это не влияет —
      // WHERE просто делает сам UPDATE идемпотентным no-op для гонки, вместо порчи данных.
      // updated_at СОЗНАТЕЛЬНО НЕ трогаем (найдено адверсариальной проверкой фиксов): тик цены —
      // не изменение состояния позиции, а его переоценка. Бампая его каждую секунду, мы делали
      // бесполезным гейт реконсиляции «зеркало свежее снапшота биржи» (reconcile.ts, шаг Б2):
      // фантомная строка сама себя держит в подписке тикера и всегда выглядит только что
      // обновлённой — то есть шаг Б2 не сработал бы в проде НИКОГДА. Единственный потребитель
      // positions.updated_at — как раз этот гейт (api сортирует по trades.opened_at, см.
      // positions.service.ts:20).
      await trx
        .updateTable('positions')
        .set({ mark_price: markPrice, unrealised_pnl: pnl.toString() })
        .where('channel_id', '=', row.channel_id)
        .where('symbol', '=', symbol)
        .where(sql<boolean>`size <> 0`)
        .execute()
      if (emit) await emitPositionUpsert(trx, row.channel_id, symbol)
    })
  }

  return emit
}
