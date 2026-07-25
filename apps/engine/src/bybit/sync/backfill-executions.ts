// Догон исполнений с биржи по водяному знаку — то, чего не было вообще: WS не переигрывает
// пропущенное, поэтому любой филл, случившийся пока движок лежал (или пока WS был в обрыве),
// терялся НАВСЕГДА. Здесь мы дочитываем `/v5/execution/list` окнами и вставляем недостающее.
//
// ⚠️ ГЛАВНАЯ ЛОВУШКА, из-за которой наивный догон СДЕЛАЛ БЫ ХУЖЕ: `/v5/execution/list` НЕ содержит
// поля execPnl (проверено на живом ответе — там только execFee). Если вставить такие строки с
// exec_pnl = 0 и пересчитать сделку (realized_pnl = SUM(exec_pnl)), мы ОБНУЛИМ уже правильно
// посчитанный PnL. Поэтому REST-строки помечаются source='rest', а их exec_pnl проставляется
// ОТДЕЛЬНЫМ шагом из /v5/position/closed-pnl (см. backfill-closed-pnl.ts) — и только там.
// Пересчёт денег сделки вызывается ПОСЛЕ этого шага, не здесь.

import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Execution, Order } from '../rest-client.js'
import { attributeExecution, type AttributionKind } from './attribute.js'
import { chunkWindows, resolveSyncFrom, writeCursor, type SyncWindow } from './cursor.js'

export interface ExecutionsBackfillRest {
  getExecutions(params: { startTime?: number; endTime?: number }): Promise<Execution[]>
  getOrderHistory(params: { orderId?: string; startTime?: number; endTime?: number }): Promise<Order[]>
}

export interface BackfillExecutionsResult {
  fetched: number
  inserted: number
  /** Филлы, опознанные как РУЧНЫЕ действия оператора на бирже (закрытие/фиксация мимо наших ордеров). */
  manual: number
  /** Филлы, которые не удалось привязать ни к одной сделке — помечены в audit_log. */
  unattributed: number
  /** Сделки, затронутые догоном: их деньги надо пересчитать (делает вызывающий, после closed-pnl). */
  affectedTradeIds: string[]
  truncated: boolean
}

/** Bybit шлёт по открытой позиции строки фандинга. У них execQty = размер позиции, closedSize = 0 —
 *  они НЕ являются торговыми исполнениями и не должны влиять ни на размер, ни на среднюю цену.
 *  В деньгах они участвуют только комиссией (exec_fee), что и обеспечивает SUM(exec_fee). */
function isFundingRow(exec: Execution): boolean {
  return exec.execType === 'Funding'
}

export async function backfillExecutions(
  db: Kysely<DB>,
  rest: ExecutionsBackfillRest,
  nowMs: number,
  oldestLiveTradeMs?: number | null,
): Promise<BackfillExecutionsResult> {
  const { from, truncated } = await resolveSyncFrom(db, 'sync:executions', nowMs, oldestLiveTradeMs)
  const windows = chunkWindows(from, nowMs)

  const result: BackfillExecutionsResult = {
    fetched: 0,
    inserted: 0,
    manual: 0,
    unattributed: 0,
    affectedTradeIds: [],
    truncated,
  }
  const affected = new Set<string>()

  // Кэш походов в order/history: у нескольких филлов одного стоп-ордера общий orderId.
  const orderCache = new Map<string, Order | undefined>()
  const lookupOrder = async (bybitOrderId: string): Promise<Order | undefined> => {
    if (orderCache.has(bybitOrderId)) return orderCache.get(bybitOrderId)
    const [found] = await rest.getOrderHistory({ orderId: bybitOrderId })
    orderCache.set(bybitOrderId, found)
    return found
  }

  for (const window of windows) {
    const execs = await fetchWindow(rest, window)
    result.fetched += execs.length

    // Хронологический порядок: деньги и статусы должны применяться так, как это происходило на бирже.
    const ordered = [...execs].sort((a, b) => Number(a.execTime) - Number(b.execTime))

    for (const exec of ordered) {
      const applied = await applyRestExecution(db, exec, lookupOrder)
      if (!applied.inserted) continue

      result.inserted++
      if (applied.kind === 'manual') result.manual++
      if (applied.kind === 'none') result.unattributed++
      if (applied.tradeId) affected.add(applied.tradeId)
    }

    // Курсор двигаем ТОЛЬКО после полностью потреблённого окна: крэш посреди догона просто заставит
    // перечитать окно заново, а дубликаты бесплатны (UNIQUE bybit_exec_id).
    await writeCursor(db, 'sync:executions', window.end)
  }

  result.affectedTradeIds = [...affected]
  return result
}

async function fetchWindow(rest: ExecutionsBackfillRest, window: SyncWindow): Promise<Execution[]> {
  return rest.getExecutions({ startTime: window.start, endTime: window.end })
}

interface AppliedExecution {
  inserted: boolean
  tradeId: string | null
  kind: AttributionKind
}

/**
 * Идемпотентная вставка одного REST-исполнения + атрибуция (в т.ч. РУЧНЫХ действий оператора).
 * exec_pnl намеренно 0: у REST-строк его нет, реальный PnL проставит backfill-closed-pnl.
 */
async function applyRestExecution(
  db: Kysely<DB>,
  exec: Execution,
  lookupOrder: (bybitOrderId: string) => Promise<Order | undefined>,
): Promise<AppliedExecution> {
  return db.transaction().execute(async (trx) => {
    const execTs = new Date(Number(exec.execTime))
    const orderLinkId = exec.orderLinkId && exec.orderLinkId.length > 0 ? exec.orderLinkId : null

    // Фандинг не торговая операция — атрибутируем по символу, но ордер ему не ищем.
    const attribution = isFundingRow(exec)
      ? await attributeExecution(trx, { orderLinkId: null, symbol: exec.symbol, execTs })
      : await attributeExecution(
          trx,
          { orderLinkId, bybitOrderId: exec.orderId, symbol: exec.symbol, execTs },
          lookupOrder,
        )

    const row = await trx
      .insertInto('executions')
      .values({
        order_id: attribution.orderId,
        trade_id: attribution.tradeId,
        leg_id: attribution.legId,
        bybit_exec_id: exec.execId,
        bybit_order_id: exec.orderId,
        order_link_id: orderLinkId,
        symbol: exec.symbol,
        side: exec.side === 'Sell' ? 'short' : 'long',
        exec_qty: exec.execQty,
        exec_price: exec.execPrice,
        closed_size: exec.closedSize ?? '0',
        leaves_qty: exec.leavesQty ?? '0',
        exec_fee: exec.execFee ?? '0',
        // НЕ выдумываем PnL: /v5/execution/list его не отдаёт. Проставит backfill-closed-pnl.
        exec_pnl: '0',
        exec_type: exec.execType ?? null,
        create_type: exec.createType ?? null,
        bybit_seq: exec.seq ?? null,
        source: 'rest',
        is_maker: exec.isMaker ?? false,
        exec_ts: execTs,
      })
      .onConflict((oc) => oc.column('bybit_exec_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!row) return { inserted: false, tradeId: null, kind: attribution.kind } // уже знали об этом филле

    // Ручное вмешательство: журнал обязан это зафиксировать — и для оператора (audit_log), и для
    // автоматики (manual_override запрещает каналу дальше двигать SL/TP этой сделки).
    if (attribution.kind === 'manual' && attribution.tradeId) {
      await trx
        .updateTable('trades')
        .set({ manual_override: true, needs_review: true, updated_at: new Date() })
        .where('id', '=', attribution.tradeId)
        .execute()

      // audit_log не типизирован в Kysely (как и в reconcile.ts) — пишем тем же сырым SQL.
      const meta = JSON.stringify({
        symbol: exec.symbol,
        execId: exec.execId,
        execQty: exec.execQty,
        execPrice: exec.execPrice,
        closedSize: exec.closedSize,
        createType: exec.createType,
        orderLinkId: exec.orderLinkId,
      })
      await sql`
        INSERT INTO audit_log (actor, action, entity_type, entity_id, meta, message)
        VALUES (
          'reconcile', 'manual_action_detected', 'trade', ${attribution.tradeId}, ${meta}::jsonb,
          'исполнение на бирже мимо наших ордеров — ручное действие оператора; сделка помечена manual_override'
        )
      `.execute(trx)
    }

    if (attribution.kind === 'none' && !isFundingRow(exec)) {
      const meta = JSON.stringify({
        symbol: exec.symbol,
        execQty: exec.execQty,
        execPrice: exec.execPrice,
        orderLinkId: exec.orderLinkId,
      })
      await sql`
        INSERT INTO audit_log (actor, action, entity_type, entity_id, meta, message)
        VALUES (
          'reconcile', 'unattributed_execution', 'execution', ${exec.execId}, ${meta}::jsonb,
          'исполнение на бирже, которое не удалось привязать ни к одной сделке журнала — нужен ручной разбор'
        )
      `.execute(trx)
    }

    return { inserted: true, tradeId: attribution.tradeId, kind: attribution.kind }
  })
}
