// Операционная правка ОТЛОЖЕННОГО входа: изменить объём и/или прикреплённый стоп у ещё не
// исполненной лимитки, не разрывая её связь со сделкой.
//
// ЗАЧЕМ. Единственная альтернатива — поставить руками отдельный ордер на бирже — ломает систему:
// его исполнение приходит как «мимо наших ордеров», и приватный WS уводит сделку в
// manual_override (private-ws.ts), после чего бот перестаёт ею управлять. Правка через
// `POST /v5/order/amend` сохраняет и orderId, и orderLinkId — будущий филл атрибутируется как
// обычно.
//
// Живой повод (27.07.2026): лимитка ETHUSDT была выставлена по старому смыслу trade_size (тогда
// это был размер позиции, а не маржа), и заказчик решил довести её до задуманного объёма и
// передвинуть стоп под нужный риск.

import { Decimal } from 'decimal.js'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'

export interface AmendPendingEntryParams {
  orderLinkId: string
  /** Новый объём (в базовой валюте). Не задан — остаётся прежним. */
  qty?: string
  /** Новая цена прикреплённого защитного стопа. Не задана — остаётся прежней. */
  stopLoss?: string
}

/** Минимальный контракт клиента — как везде в движке, чтобы тесты обходились без сети. */
export interface AmendRestClient {
  amendOrder(params: {
    symbol: string
    orderLinkId: string
    qty?: string
    price?: string
    stopLoss?: string
  }): Promise<{ ok: true; idempotent?: boolean }>
}

export interface PendingEntry {
  orderId: string
  tradeId: string
  legId: string | null
  humanRef: string
  symbol: string
  side: string
  qty: string
  price: string | null
  stopLoss: string | null
  status: string
  tradeStatus: string
}

/** Читает отложенный вход и его текущий стоп — для предпросмотра и проверок перед правкой. */
export async function findPendingEntry(db: Kysely<DB>, orderLinkId: string): Promise<PendingEntry | null> {
  const order = await db
    .selectFrom('orders')
    .innerJoin('trades', 'trades.id', 'orders.trade_id')
    .select([
      'orders.id as orderId',
      'orders.trade_id as tradeId',
      'orders.leg_id as legId',
      'orders.symbol as symbol',
      'orders.side as side',
      'orders.qty as qty',
      'orders.price as price',
      'orders.status as status',
      'orders.purpose as purpose',
      'trades.human_ref as humanRef',
      'trades.status as tradeStatus',
    ])
    .where('orders.order_link_id', '=', orderLinkId)
    .executeTakeFirst()
  if (!order || order.tradeId === null) return null

  // Стоп живёт отдельной строкой orders(purpose='sl') — она пишется вместе с входом, когда стоп
  // ушёл на биржу прикреплённым к ордеру (bybit.adapter.ts::recordStopLossOrder).
  const sl = await db
    .selectFrom('orders')
    .select(['price'])
    .where('trade_id', '=', order.tradeId)
    .where('purpose', '=', 'sl')
    .where('status', '!=', 'cancelled')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()

  return {
    orderId: order.orderId,
    tradeId: order.tradeId,
    legId: order.legId,
    humanRef: order.humanRef,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty ?? '0',
    price: order.price,
    stopLoss: sl?.price ?? null,
    status: order.status,
    tradeStatus: order.tradeStatus,
  }
}

export interface AmendGuard {
  allowed: boolean
  reason?: string
}

/**
 * Правка имеет смысл ТОЛЬКО пока ордер не исполнен: у исполненного менять объём поздно (позиция
 * уже открыта — это делается доливкой/частичным закрытием), а у отменённого нечего.
 */
export function checkAmendGuard(entry: PendingEntry): AmendGuard {
  if (entry.status !== 'submitted') {
    return { allowed: false, reason: `ордер в статусе '${entry.status}' — править можно только неисполненный ('submitted')` }
  }
  if (entry.tradeStatus === 'closed' || entry.tradeStatus === 'cancelled') {
    return { allowed: false, reason: `сделка ${entry.humanRef} в статусе '${entry.tradeStatus}' — сначала верните её в работу` }
  }
  return { allowed: true }
}

/**
 * Правит ордер на бирже и приводит журнал в соответствие. Порядок важен: сначала биржа (её отказ
 * не должен оставить журнал с цифрами, которых на бирже нет), потом БД одной транзакцией.
 */
export async function amendPendingEntry(
  db: Kysely<DB>,
  rest: AmendRestClient,
  entry: PendingEntry,
  params: AmendPendingEntryParams,
): Promise<void> {
  await rest.amendOrder({
    symbol: entry.symbol,
    orderLinkId: params.orderLinkId,
    ...(params.qty !== undefined ? { qty: params.qty } : {}),
    ...(params.stopLoss !== undefined ? { stopLoss: params.stopLoss } : {}),
  })

  await db.transaction().execute(async (trx) => {
    const now = new Date()

    if (params.qty !== undefined) {
      await trx.updateTable('orders').set({ qty: params.qty, updated_at: now }).where('id', '=', entry.orderId).execute()
      // Плановый объём сделки: пока входа не было, trades.size — это «сколько собираемся взять».
      await trx
        .updateTable('trades')
        .set({ size: params.qty, initial_size: params.qty, updated_at: now })
        .where('id', '=', entry.tradeId)
        .execute()
      if (entry.legId !== null) {
        await trx.updateTable('trade_legs').set({ requested_qty: params.qty }).where('id', '=', entry.legId).execute()
      }
    }

    if (params.stopLoss !== undefined) {
      // Строка стопа обновляется вместе с объёмом: она защищает ровно этот вход целиком.
      await trx
        .updateTable('orders')
        .set({ price: params.stopLoss, ...(params.qty !== undefined ? { qty: params.qty } : {}), updated_at: now })
        .where('trade_id', '=', entry.tradeId)
        .where('purpose', '=', 'sl')
        .where('status', '!=', 'cancelled')
        .execute()
    }
  })
}

/**
 * Цена стопа, при которой убыток по позиции равен заданной доле депозита.
 * Считает от объёма и цены входа: loss = qty * |entry - sl| ⇒ sl = entry ∓ (equity * pct/100) / qty.
 */
export function stopLossForRisk(params: {
  side: 'long' | 'short'
  entry: Decimal.Value
  qty: Decimal.Value
  equity: Decimal.Value
  riskPct: Decimal.Value
}): Decimal {
  const entry = new Decimal(params.entry)
  const distance = new Decimal(params.equity).mul(new Decimal(params.riskPct).div(100)).div(params.qty)
  return params.side === 'long' ? entry.minus(distance) : entry.plus(distance)
}
