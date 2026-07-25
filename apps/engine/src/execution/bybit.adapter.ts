import { Decimal } from 'decimal.js'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network, OrderPurpose, Side } from 'shared/domain.js'
import type { BybitRestClient } from '../bybit/rest-client.js'
import { getInstrument } from '../instruments.js'
import { floorTo } from '../risk/leverage.js'
import { orderLinkId } from './order-link-id.js'
import type {
  CancelOrderParams,
  ClosePositionParams,
  EntryOrder,
  ExecutionPort,
  OrderContext,
  PlaceTpLadderParams,
  SetStopLossParams,
} from './port.js'

/**
 * BybitAdapter — вторая (реальная) реализация ExecutionPort (Ф3, задача 2; research
 * bybit-execution.md §1/§2/§4/§5/§8). В отличие от DryRunAdapter (Ф1), КАЖДЫЙ метод сначала
 * зовёт реальный Bybit V5 REST (через BybitRestClient — единственная сетевая точка входа,
 * см. bybit/rest-client.ts), и только ПОСЛЕ успешного (или идемпотентного) ответа биржи пишет
 * локальную запись `orders` — с `bybit_order_id` из ответа, чтобы приватный WS-мост (Ф3, задача 3)
 * впоследствии мог найти этот ордер по `orderLinkId` и приписать к нему реальные филлы.
 *
 * СОЗНАТЕЛЬНОЕ ОТСТУПЛЕНИЕ от буквального текста брифа ("пишет orders/executions из ответа
 * Bybit"): этот адаптер пишет ТОЛЬКО `orders`, не трогает `executions`/`positions`. Причина —
 * `createOrder` Bybit возвращает лишь `orderId`/`orderLinkId`, БЕЗ цены/qty реального филла;
 * "изобретение" execution-строки на основе переданной клиентом цены (order.price — та же
 * "симулированная цена" из EntryOrder, задуманная для DryRunAdapter без живого фида, см.
 * port.ts) для LIVE-ордера означало бы: (а) заявить исполнение, которого могло не быть
 * (rejected/частичный филл/проскальзывание), (б) при последующем приходе НАСТОЯЩЕГО
 * `execution` из приватного WS (задача 3, execId реальный) — задвоить филл/PnL в агрегатах,
 * т.к. WS не знает об этой "угаданной" строке. Реальные executions/positions — зона
 * ответственности приватного WS-моста (задача 3) и реконсиляции при старте (задача 4), которые
 * читают правду с биржи, а не предполагают её. `orders` со статусом 'submitted' (а не 'filled')
 * отражает это честно: подтверждена ТОЛЬКО постановка, не исполнение.
 *
 * Округление (research §7, задание задачи): qty — floor к instrument.qtyStep, leverage — floor
 * к instrument.leverageStep, price — к instrument.tickSize НАПРАВЛЕННО по стороне ордера
 * (Buy → floor, чтобы не переплатить/не продать дешевле замысла; Sell → ceil — симметрично):
 * это верно и для входа/TP (выгоднее исполнение), и для SL (см. roundPriceToTick ниже) —
 * в обоих случаях "не хуже задуманного уровня" для long/short совпадает с "floor для Buy/ceil
 * для Sell" после перевода side→сторона_ордера. Это последний рубеж перед реальными деньгами —
 * дублирует (не заменяет) уже сделанное округление qty в pipeline.ts (buildTpTargets/computeSize),
 * т.к. BybitAdapter — самое последнее место перед сетевым вызовом биржи (defence in depth).
 */

/** Узкий срез BybitRestClient, реально нужный адаптеру — упрощает мок в тестах (без apiKey/apiSecret). */
export type BybitAdapterRestClient = Pick<
  BybitRestClient,
  'switchMode' | 'setLeverage' | 'createOrder' | 'setTradingStop' | 'cancelOrder' | 'cancelAll'
>

export class BybitAdapter implements ExecutionPort {
  constructor(
    private readonly rest: BybitAdapterRestClient,
    private readonly network: Network,
  ) {}

  async placeEntry(tx: Kysely<DB>, order: EntryOrder): Promise<{ orderId: string; orderLinkId: string }> {
    const linkId = buildLinkId(order, order.purpose, 0)
    const instrument = await getInstrumentOrThrow(tx, order.symbol, this.network)

    // one-way (research §1) — идемпотентно на каждый вход: повторный switch-mode на уже
    // выставленный режим Bybit возвращает 110025, rest-client глотает как {ok:true}.
    await this.rest.switchMode(order.symbol, 0)

    const leverage = floorTo(instrument.leverageStep, order.leverage).toString()
    // 110043 ("плечо не изменилось") — идемпотентный успех, rest-client уже это обрабатывает.
    await this.rest.setLeverage(order.symbol, leverage)

    const qty = floorTo(instrument.qtyStep, order.qty).toString()
    const bybitSide = toBybitSide(order.side, true)
    const isMarket = order.orderType === 'market'
    const submittedPrice = isMarket ? order.price : roundPriceToTick(bybitSide, order.price, instrument.tickSize).toString()

    // Critical C1 адверсариального ревью (p3-core-fix-report.md): SL — АТОМАРНО в теле ЭТОГО ЖЕ
    // createOrder (closeSide/roundPriceToTick — та же направленная логика округления, что и
    // setStopLoss/placeTpLadder ниже: "не отдать больше, чем задумано"). order.stopLoss не задан
    // (напр. purpose='add' — доливка на уже защищённую позицию) -> undefined проходит насквозь,
    // Bybit не получает поле вовсе (rest-client.ts::createOrder), поведение как до этого фикса.
    const closeSide = toBybitSide(order.side, false)
    const slPrice = order.stopLoss !== undefined ? roundPriceToTick(closeSide, order.stopLoss, instrument.tickSize).toString() : undefined

    const result = await this.rest.createOrder({
      symbol: order.symbol,
      side: bybitSide,
      orderType: isMarket ? 'Market' : 'Limit',
      qty,
      ...(isMarket ? {} : { price: submittedPrice }),
      orderLinkId: linkId,
      positionIdx: 0,
      ...(slPrice !== undefined ? { stopLoss: slPrice } : {}),
    })

    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: order.tradeId,
        leg_id: order.legId,
        action_id: order.actionId,
        channel_id: order.channelId,
        symbol: order.symbol,
        order_link_id: linkId,
        bybit_order_id: result.orderId || null,
        purpose: order.purpose,
        side: order.side,
        order_type: order.orderType,
        reduce_only: false,
        qty,
        price: submittedPrice,
        status: 'submitted',
        submitted_at: new Date(),
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) {
      // Дубль orderLinkId (110072, research §8) ИЛИ гонка с уже записанной строкой — идемпотентный
      // успех, не плодим вторую строку/второй реальный ордер на бирже (и не пишем вторую sl-строку
      // ниже — она уже была написана первым успешным вызовом).
      const existing = await findOrderId(tx, linkId)
      return { orderId: existing, orderLinkId: linkId }
    }

    if (slPrice !== undefined) {
      // Локальная запись SL — БЕЗ второго сетевого вызова (он уже атомарно ушёл выше, вместе со
      // входом): только строка orders(purpose='sl') для аудита/UI и для будущего cancelOrder
      // (Important I1 — setTradingStop(0), а не order/cancel). bybit_order_id намеренно null —
      // trading-stop остаётся атрибутом позиции, не отдельным ордером, даже переданный атомарно.
      await this.recordStopLossOrder(tx, order, qty, slPrice)
    }

    return { orderId: inserted.id, orderLinkId: linkId }
  }

  async placeTpLadder(tx: Kysely<DB>, params: PlaceTpLadderParams): Promise<{ orderIds: string[] }> {
    const instrument = await getInstrumentOrThrow(tx, params.symbol, this.network)
    const closeSide = toBybitSide(params.side, false) // reduceOnly — сторона, противоположная позиции
    const orderIds: string[] = []

    // Последовательно (не Promise.all) — тот же приём, что DryRunAdapter: общий tx, независимые
    // orderLinkId на цель, ладдер обычно 2-5 целей, не тысяча.
    for (const tp of params.tps) {
      const linkId = buildLinkId(params, 'tp', tp.index)
      // floor к qtyStep — защитный повтор округления (pipeline.ts уже делит total на доли и
      // округляет, последняя добивает остаток; здесь — idempotent no-op в норме, страховка на
      // случай будущего вызывающего кода, который этого не сделал).
      const qty = floorTo(instrument.qtyStep, tp.qty).toString()
      const price = roundPriceToTick(closeSide, tp.price, instrument.tickSize).toString()

      const result = await this.rest.createOrder({
        symbol: params.symbol,
        side: closeSide,
        orderType: 'Limit',
        qty,
        price,
        orderLinkId: linkId,
        reduceOnly: true,
        timeInForce: 'GTC',
        positionIdx: 0,
      })

      const inserted = await tx
        .insertInto('orders')
        .values({
          trade_id: params.tradeId,
          action_id: params.actionId,
          channel_id: params.channelId,
          symbol: params.symbol,
          order_link_id: linkId,
          bybit_order_id: result.orderId || null,
          purpose: 'tp',
          side: params.side,
          order_type: 'limit',
          reduce_only: true,
          qty,
          price,
          tp_index: tp.index,
          status: 'submitted',
          submitted_at: new Date(),
        })
        .onConflict((oc) => oc.column('order_link_id').doNothing())
        .returning('id')
        .executeTakeFirst()

      orderIds.push(inserted ? inserted.id : await findOrderId(tx, linkId))
    }

    return { orderIds }
  }

  async setStopLoss(tx: Kysely<DB>, params: SetStopLossParams): Promise<{ orderId: string }> {
    const instrument = await getInstrumentOrThrow(tx, params.symbol, this.network)
    const closeSide = toBybitSide(params.side, false)
    const qty = floorTo(instrument.qtyStep, params.qty).toString()
    const price = roundPriceToTick(closeSide, params.price, instrument.tickSize).toString()

    // trading-stop Full (research §5) — гарантированный market-close ВСЕГО остатка при триггере,
    // slSize=qty (остаток позиции на момент вызова). НЕ смешивать с tpSize в одном вызове
    // (research §4: "tpSize и slSize должны совпадать", если оба переданы) — здесь передаём
    // только SL-поля, TP уже ушли отдельными reduceOnly-ордерами в placeTpLadder. Используется
    // ТОЛЬКО для последующих правок SL уже открытой позиции (handleDelta: sl_breakeven/sl_set) —
    // SL исходного входа теперь ставится атомарно в placeEntry (Critical C1), не здесь.
    await this.rest.setTradingStop({
      symbol: params.symbol,
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: price,
      slSize: qty,
    })

    return this.recordStopLossOrder(tx, params, qty, price)
  }

  /**
   * Локальная запись строки `orders(purpose='sl')` — общая для setStopLoss() (сетевой вызов
   * setTradingStop уже произошёл у вызывающей стороны) и placeEntry() (SL атомарно ушёл вместе
   * со входом, второй сетевой вызов НЕ нужен, см. Critical C1 выше) — единственный источник этой
   * логики (DRY), идемпотентно по order_link_id (ON CONFLICT DO NOTHING). bybit_order_id
   * намеренно не устанавливается — trading-stop не отдельный ордер, у него нет orderId.
   */
  private async recordStopLossOrder(tx: Kysely<DB>, ctx: OrderContext, qty: string, price: string): Promise<{ orderId: string }> {
    const linkId = buildLinkId(ctx, 'sl', 0)
    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: ctx.tradeId,
        action_id: ctx.actionId,
        channel_id: ctx.channelId,
        symbol: ctx.symbol,
        order_link_id: linkId,
        purpose: 'sl',
        side: ctx.side,
        order_type: 'limit',
        reduce_only: true,
        qty,
        price,
        status: 'submitted',
        submitted_at: new Date(),
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) return { orderId: await findOrderId(tx, linkId) }
    return { orderId: inserted.id }
  }

  async closePosition(tx: Kysely<DB>, params: ClosePositionParams): Promise<{ orderId: string }> {
    const instrument = await getInstrumentOrThrow(tx, params.symbol, this.network)
    const closeSide = toBybitSide(params.side, false)
    const qty = floorTo(instrument.qtyStep, params.qty).toString()
    const linkId = buildLinkId(params, 'close', params.seq ?? 0)

    const result = await this.rest.createOrder({
      symbol: params.symbol,
      side: closeSide,
      orderType: 'Market',
      qty,
      orderLinkId: linkId,
      reduceOnly: true,
      positionIdx: 0,
    })

    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: params.tradeId,
        action_id: params.actionId,
        channel_id: params.channelId,
        symbol: params.symbol,
        order_link_id: linkId,
        bybit_order_id: result.orderId || null,
        purpose: 'close',
        side: params.side,
        order_type: 'market',
        reduce_only: true,
        qty,
        status: 'submitted',
        submitted_at: new Date(),
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) return { orderId: await findOrderId(tx, linkId) }
    return { orderId: inserted.id }
  }

  /**
   * Снять ВСЕ висящие ордера символа (R8) после нашего же полного закрытия позиции. Раньше это
   * делал обработчик flat-пуша приватного WS; теперь пайплайн зовёт явно, сразу после коммита —
   * пуш мог не дойти, а висящий reduceOnly-остаток на закрытом символе живёт до реконсиляции.
   * Идемпотентно: повторный cancel-all по символу без ордеров — успех без эффекта.
   */
  async cancelAllForSymbol(symbol: string): Promise<void> {
    await this.rest.cancelAll(symbol)
  }

  async cancelOrder(tx: Kysely<DB>, params: CancelOrderParams): Promise<void> {
    // CancelOrderParams (port.ts) не несёт symbol — читаем его из уже записанной локальной
    // строки orders по orderLinkId (не расширяем общий межадаптерный интерфейс ради одного поля,
    // нужного только здесь; DryRunAdapter вообще не ходит к бирже и symbol ему не нужен).
    const order = await tx
      .selectFrom('orders')
      .select(['symbol', 'status', 'purpose', 'bybit_order_id'])
      .where('order_link_id', '=', params.orderLinkId)
      .executeTakeFirst()

    if (!order) return // нечего отменять — ни локально, ни на бирже; не ошибка (идемпотентно)
    if (order.status === 'filled' || order.status === 'cancelled') return // терминальный статус — к бирже не ходим

    if (order.purpose === 'sl' && order.bybit_order_id === null) {
      // Important I1 адверсариального ревью: SL хранится как trading-stop (атрибут позиции, см.
      // recordStopLossOrder выше) — у него НЕТ bybit_order_id, `order/cancel` по его orderLinkId
      // вернул бы 110001 "ордер не существует" и бросил бы исключение (заклинивание delta/свипа).
      // Снимаем ЕДИНСТВЕННО ВЕРНЫМ способом — тем же вызовом, что и постановку: stopLoss='0'.
      await this.rest.setTradingStop({ symbol: order.symbol, positionIdx: 0, tpslMode: 'Full', stopLoss: '0' })
    } else {
      await this.rest.cancelOrder({ symbol: order.symbol, orderLinkId: params.orderLinkId })
    }

    await tx
      .updateTable('orders')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('order_link_id', '=', params.orderLinkId)
      .where('status', '!=', 'filled')
      .where('status', '!=', 'cancelled')
      .execute()
  }
}

/** orderLinkId({mode:'live', ...}) — BybitAdapter всегда строит ключ с префиксом 'K' (research §8). */
function buildLinkId(ctx: OrderContext, purpose: OrderPurpose, legIndex: number): string {
  return orderLinkId({
    mode: 'live',
    channelOrd: ctx.channelOrd,
    tgMessageId: ctx.tgMessageId,
    actionIndex: ctx.actionIndex,
    purpose,
    legIndex,
  })
}

async function findOrderId(tx: Kysely<DB>, linkId: string): Promise<string> {
  const row = await tx.selectFrom('orders').select('id').where('order_link_id', '=', linkId).executeTakeFirstOrThrow()
  return row.id
}

async function getInstrumentOrThrow(tx: Kysely<DB>, symbol: string, network: Network) {
  const instrument = await getInstrument(tx, symbol, network)
  if (!instrument) {
    throw new Error(`BybitAdapter: инструмент ${symbol}/${network} не найден в кэше instruments`)
  }
  return instrument
}

/**
 * Позиционная сторона → сторона РЕАЛЬНОГО ордера на Bybit. `opening=true` — вход/добор (та же
 * сторона, что и позиция); `opening=false` — reduceOnly (TP/SL/close) закрывает позицию
 * ПРОТИВОПОЛОЖНОЙ стороной (long закрывается Sell, short — Buy).
 */
function toBybitSide(side: Side, opening: boolean): 'Buy' | 'Sell' {
  const positionSide: 'Buy' | 'Sell' = side === 'long' ? 'Buy' : 'Sell'
  if (opening) return positionSide
  return positionSide === 'Buy' ? 'Sell' : 'Buy'
}

/**
 * Приводит цену к тику instrument.tickSize, НАПРАВЛЕННО по стороне ордера (research §7): Buy →
 * floor (не переплатить / не купить дороже задуманного), Sell → ceil (не продать дешевле
 * задуманного). Не round(), т.к. round() мог бы двигать цену В ЛЮБУЮ сторону от намерения.
 */
function roundPriceToTick(orderSide: 'Buy' | 'Sell', price: string, tickSize: string): Decimal {
  const p = new Decimal(price)
  const step = new Decimal(tickSize)
  return orderSide === 'Buy' ? p.div(step).floor().mul(step) : p.div(step).ceil().mul(step)
}
