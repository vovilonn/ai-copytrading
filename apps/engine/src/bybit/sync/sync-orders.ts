// Синхронизация статусов ордеров с биржей. Раньше этого шага не было ВООБЩЕ: единственным писателем
// orders.status в live был WS-пуш. Стоило WS пропустить пуш (обрыв, даунтайм, гонка с коммитом) —
// и статус расходился НАВСЕГДА, репара не существовало.
//
// Это не косметика. Протухший 'submitted' у реально исполненного ордера ломает торговлю:
// cancel_pending выбирает ордера по status IN ('created','pending_submit','submitted') и отправляет
// отмену уже исполненного → Bybit 110001 → исключение → откат транзакции дельты.
// Живой пример расхождения: K01-9999001-00-E0 в журнале 'cancelled', на бирже Filled (cumExecQty=0.2).
//
// ⚠️ ГЕЙТ ТЕРМИНАЛЬНОГО СТАТУСА ЗДЕСЬ ИНОЙ, ЧЕМ У WS. У WS есть гейт «не понижать терминальный» —
// он нужен, потому что ретрай атрибуции может переупорядочить пуши. Но REST — это СНАПШОТ БИРЖИ,
// а терминальные статусы у биржи иммутабельны: если она говорит Filled, значит Filled, даже если у
// нас записано 'cancelled'. Поэтому REST-репар применяет статус биржи безусловно.

import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Order } from '../rest-client.js'
import { mapOrderStatus } from '../private-ws.js'
import { chunkWindows } from './cursor.js'

/** Наши live-ордера (execution/order-link-id.ts::MODE_PREFIX.live). Чужие/ручные не трогаем. */
const LIVE_ORDER_LINK_PREFIX = 'K'

export interface SyncOrdersRest {
  getOpenOrders(symbol?: string): Promise<Order[]>
  getOrderHistory(params: { startTime?: number; endTime?: number }): Promise<Order[]>
}

export interface SyncOrdersResult {
  /** Сколько локальных строк orders приведено в соответствие с биржей. */
  updated: number
  /** Ордера журнала, которых биржа не знает вовсе (не дошли до неё) — помечены в audit_log. */
  unknownOnExchange: number
}

export async function syncOrderStatuses(
  db: Kysely<DB>,
  rest: SyncOrdersRest,
  historyFrom: number,
  nowMs: number,
): Promise<SyncOrdersResult> {
  const result: SyncOrdersResult = { updated: 0, unknownOnExchange: 0 }

  // Локальные ордера, которые мы считаем ещё «живыми». Терминальные не перепроверяем — кроме тех,
  // что биржа опровергнет в истории ниже (D3: 'cancelled' у нас, Filled у неё).
  const locals = await db
    .selectFrom('orders')
    .select(['id', 'order_link_id', 'status', 'trade_id'])
    .where('order_link_id', 'like', `${LIVE_ORDER_LINK_PREFIX}%`)
    .execute()
  if (locals.length === 0) return result

  const byLinkId = new Map(locals.map((o) => [o.order_link_id, o]))

  // История режется на окна: лимит ОДНОГО запроса Bybit — 7 дней (retCode 10001). Одним куском
  // просить нельзя даже за неделю — нахлёст курсора выводит окно за лимит.
  const windows = chunkWindows(historyFrom, nowMs)
  const historyPages = await Promise.all(
    windows.map((window) => rest.getOrderHistory({ startTime: window.start, endTime: window.end })),
  )
  const live = await rest.getOpenOrders()

  // История важнее realtime: там терминальные статусы. Применяем realtime первым, историю — поверх.
  const exchangeOrders: Order[] = [...live, ...historyPages.flat()]

  const seen = new Set<string>()
  for (const exchangeOrder of exchangeOrders) {
    const linkId = exchangeOrder.orderLinkId
    if (!linkId || !linkId.startsWith(LIVE_ORDER_LINK_PREFIX)) continue

    const local = byLinkId.get(linkId)
    if (!local) continue

    const status = mapOrderStatus(exchangeOrder.orderStatus)
    seen.add(linkId)

    if (local.status === status) continue

    await db
      .updateTable('orders')
      .set({
        status,
        bybit_order_id: exchangeOrder.orderId,
        updated_at: new Date(),
        ...(status === 'filled' ? { filled_at: new Date() } : {}),
        ...(status === 'cancelled' ? { cancelled_at: new Date() } : {}),
      })
      .where('id', '=', local.id)
      .execute()

    result.updated++
  }

  return result
}
