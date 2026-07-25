// Атрибуция исполнения к сделке журнала — сердце «подтягивания ручных действий с биржи».
//
// ЗАЧЕМ. Раньше и WS-путь (applyExecutionPush), и реконсиляция искали ордер ИСКЛЮЧИТЕЛЬНО по нашему
// order_link_id. Из-за этого терялись целые классы событий, причём БЕЗ всякого даунтайма:
//
//  1. Оператор закрыл/частично зафиксировал позицию руками в интерфейсе Bybit. У такого филла
//     orderLinkId ЧУЖОЙ (или сгенерирован биржей) → ордер не найден → executions.trade_id = NULL →
//     realized_pnl сделки не пересчитан. Живой пример из БД: TR-1204 закрыта вручную, в журнале
//     realized_pnl=0 / fees_paid=0 / is_win=NULL при реальном убытке −0.046, который лежит рядом
//     в двух осиротевших executions. Win Rate канала из-за этого врал.
//  2. Сработал trading-stop (SL позиции). У него orderLinkId ПУСТОЙ (проверено живьём), зато есть
//     parentOrderLinkId, указывающий на наш ВХОДНОЙ ордер — единственный мост обратно к сделке.
//     Без него сделка закрылась бы по стопу с PnL = 0.
//
// Три пути, в порядке убывания надёжности: наш ордер → родитель стопа → эвристика по (символ, время).

import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Order } from '../rest-client.js'
import { isEngineOrderLinkId } from '../../execution/order-link-id.js'

/** Префикс orderLinkId наших live-ордеров (execution/order-link-id.ts::MODE_PREFIX.live). */
const LIVE_ORDER_LINK_PREFIX = 'K'

/**
 * Допуск на «филл пришёл чуть позже закрытия сделки в журнале». Биржа может отдать исполнение с
 * задержкой относительно момента, когда мы уже пометили сделку закрытой (наш close-ордер исполнился,
 * closeTrade отработал, а хвостовой филл прилетел следом).
 */
const CLOSE_GRACE_MS = 5 * 60_000

export type AttributionKind = 'our_order' | 'stop_parent' | 'manual' | 'none'

export interface Attribution {
  orderId: string | null
  tradeId: string | null
  legId: string | null
  kind: AttributionKind
}

const NOT_ATTRIBUTED: Attribution = { orderId: null, tradeId: null, legId: null, kind: 'none' }

export interface AttributionInput {
  orderLinkId: string | null
  /** bybit orderId — нужен, чтобы найти родителя у trading-stop с пустым orderLinkId. */
  bybitOrderId?: string | null
  symbol: string
  execTs: Date
}

/**
 * Ищет ордер/сделку/ногу для исполнения.
 *
 * `lookupOrder` — способ достать ордер биржи по его id (order/history или order/realtime). Передаётся
 * функцией, а не клиентом: WS-путь может его не иметь (тогда путь 2 просто пропускается и мы падаем
 * на эвристику), а реконсиляция подставляет REST. Возврат undefined = «не смогли посмотреть».
 */
export async function attributeExecution(
  trx: Kysely<DB>,
  input: AttributionInput,
  lookupOrder?: (bybitOrderId: string) => Promise<Order | undefined>,
): Promise<Attribution> {
  // --- Путь 1: наш ордер (детерминированно). orderLinkId генерируем мы сами. ---
  if (input.orderLinkId) {
    const own = await trx
      .selectFrom('orders')
      .select(['id', 'trade_id', 'leg_id'])
      .where('order_link_id', '=', input.orderLinkId)
      .executeTakeFirst()
    if (own) {
      return { orderId: own.id, tradeId: own.trade_id, legId: own.leg_id, kind: 'our_order' }
    }
  }

  // --- Путь 2: сработавший trading-stop. orderLinkId пустой, но есть parentOrderLinkId → наш вход. ---
  if (!input.orderLinkId && input.bybitOrderId && lookupOrder) {
    const exchangeOrder = await lookupOrder(input.bybitOrderId)
    const parentLinkId = exchangeOrder?.parentOrderLinkId
    if (parentLinkId) {
      const parent = await trx
        .selectFrom('orders')
        .select(['trade_id'])
        .where('order_link_id', '=', parentLinkId)
        .executeTakeFirst()
      if (parent?.trade_id) {
        // order_id не проставляем: сам стоп-ордер в нашей таблице orders отдельной строкой не живёт
        // (SL идёт trading-stop'ом на позиции), а привязывать филл стопа к строке ВХОДА было бы ложью.
        return { orderId: null, tradeId: parent.trade_id, legId: null, kind: 'stop_parent' }
      }
    }
  }

  // --- Путь 2б: филл НАШЕГО trading-stop по WS. ---
  //
  // У сработавшего стопа orderLinkId ПУСТОЙ (проверено живьём), а `lookupOrder` на WS-пути не
  // передаётся — значит путь 2 там недостижим, и раньше такой филл доезжал до пути 3 и объявлялся
  // «ручным действием оператора»: живой сделке ставился manual_override, после чего канал
  // переставал двигать её защиту. Между тем пустой ключ + АКТИВНОЕ владение символом — это по
  // определению закрытие НАШЕЙ позиции (стоп, ликвидация, ADL), а не действие человека: свои
  // ордера оператор ставит из интерфейса Bybit, и у них ключ непустой.
  if (!input.orderLinkId) {
    const owned = await trx
      .selectFrom('symbol_ownership')
      .select('trade_id')
      .where('symbol', '=', input.symbol)
      .where('released_at', 'is', null)
      .executeTakeFirst()
    if (owned) {
      return { orderId: null, tradeId: owned.trade_id, legId: null, kind: 'stop_parent' }
    }
  }

  // --- Путь 3: РУЧНОЕ действие оператора. Ордера нашего нет вовсе — ищем сделку по символу и времени. ---
  //
  // ГЕЙТ (найдено живым e2e): эвристика «ручное» имеет право работать ТОЛЬКО для ЧУЖОГО ключа.
  // Наш ордер уходит на биржу ВНУТРИ ещё не закоммиченной транзакции пайплайна, а филл прилетает
  // за миллисекунды — лукап пути 1 в этот момент промахивается на СВОЁМ же ордере. Раньше такой
  // промах доходил сюда, находил живую сделку того же символа и ставил ей manual_override, после
  // чего канал молча переставал двигать её SL/TP (pipeline.ts::handleDelta). В логе одного прогона
  // — 6 таких пометок на 6 собственных исполнений подряд. Форма ключа наша и однозначная
  // (isEngineOrderLinkId), поэтому здесь просто выходим «не атрибутировано»: привязку доделает
  // либо ретрай на стороне вызывающего (private-ws), либо reattributeOrphanedExecutions.
  if (!isEngineOrderLinkId(input.orderLinkId)) {
    const manual = await findTradeBySymbolAndTime(trx, input.symbol, input.execTs)
    if (manual) {
      return { orderId: null, tradeId: manual, legId: null, kind: 'manual' }
    }
  }

  return NOT_ATTRIBUTED
}

/**
 * Эвристика для ручных филлов: сделка того же символа, которая была ЖИВА в момент исполнения.
 *
 * Берём самую позднюю по opened_at — если по символу успели пройти несколько сделок, филл относится
 * к той, что была открыта последней на этот момент. Требуем наличие НАШЕГО ('K') ордера: иначе можно
 * приписать ручной филл dry-run-сделке, у которой на бирже вообще ничего не было.
 */
async function findTradeBySymbolAndTime(trx: Kysely<DB>, symbol: string, execTs: Date): Promise<string | null> {
  const graceTs = new Date(execTs.getTime() - CLOSE_GRACE_MS)

  const trade = await trx
    .selectFrom('trades')
    .select(['id'])
    .where('symbol', '=', symbol)
    .where('opened_at', 'is not', null)
    .where('opened_at', '<=', execTs)
    // Сделка ещё не закрыта, либо закрыта совсем недавно (хвостовой филл догоняет closeTrade).
    .where((eb) => eb.or([eb('closed_at', 'is', null), eb('closed_at', '>=', graceTs)]))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('orders')
          .select('orders.id')
          .whereRef('orders.trade_id', '=', 'trades.id')
          .where('orders.order_link_id', 'like', `${LIVE_ORDER_LINK_PREFIX}%`),
      ),
    )
    .orderBy('opened_at', 'desc')
    .limit(1)
    .executeTakeFirst()

  return trade?.id ?? null
}
