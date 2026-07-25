import { Decimal } from 'decimal.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { OrderPurpose, Side } from 'shared/domain.js'
import { releaseSymbol } from '../state/trades.js'
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
 * DryRunAdapter — единственная реализация ExecutionPort в Ф1 (design spec §14: dry-run пишет
 * ТЕ ЖЕ строки БД, что писал бы live-адаптер, но не звонит бирже). НИ ОДНОГО HTTP-вызова к
 * Bybit здесь нет и не должно быть — вся "биржа" ниже полностью симулируется в Postgres:
 *   - market-ордер → сразу filled, пишется execution по переданной цене;
 *   - limit-ордер (TP-лесенка/лимитный вход) → submitted, филла не будет никогда (в Ф1 нет
 *     ни реконсилера, ни WS — ордер просто "висит" в БД так же, как висел бы на бирже).
 * Идемпотентность — по orderLinkId (UNIQUE, orders.order_link_id): повторный вызов с теми же
 * координатами сообщения (channelOrd/tgMessageId/actionIndex/purpose/legIndex) находит уже
 * существующий ордер через ON CONFLICT ... DO NOTHING и НЕ повторяет побочные эффекты
 * (execution/позиция/symbol_ownership) — тот же приём, что addLeg/acquireSymbol в state/trades.ts.
 */
export class DryRunAdapter implements ExecutionPort {
  async placeEntry(tx: Kysely<DB>, order: EntryOrder): Promise<{ orderId: string; orderLinkId: string }> {
    const linkId = buildLinkId(order, order.purpose, 0)
    const isMarket = order.orderType === 'market'

    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: order.tradeId,
        leg_id: order.legId,
        action_id: order.actionId,
        channel_id: order.channelId,
        symbol: order.symbol,
        order_link_id: linkId,
        purpose: order.purpose,
        side: order.side,
        order_type: order.orderType,
        reduce_only: false,
        qty: order.qty,
        price: order.price,
        status: isMarket ? 'filled' : 'submitted',
        submitted_at: new Date(),
        filled_at: isMarket ? new Date() : null,
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) {
      // Дубль orderLinkId = идемпотентный успех (research bybit-execution.md §8) — не плодим
      // второй ордер/филл/позицию, возвращаем уже существующий ордер как есть.
      const existing = await findOrderId(tx, linkId)
      return { orderId: existing, orderLinkId: linkId }
    }

    if (isMarket) {
      await insertSimulatedExecution(tx, {
        orderId: inserted.id,
        tradeId: order.tradeId,
        legId: order.legId,
        orderLinkId: linkId,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        price: order.price,
      })

      // Симулированный fill: mark_price = avg_price "на момент открытия" (task-6-brief.md —
      // реальный live-фид подключит задача 9). Одна атомарная SQL-формула обслуживает и
      // первый вход (INSERT), и доливку/add (ON CONFLICT — средневзвешенная цена по size).
      // liq_price (task-11-brief.md, полировка А) — просто последнее известное значение (тот же
      // приём, что и mark_price/leverage на ON CONFLICT), НЕ средневзвешенное: цена ликвидации
      // пересчитывается целиком на новом плече/avg_price при каждом входе, а не складывается.
      await sql`
        INSERT INTO positions (channel_id, symbol, trade_id, side, size, avg_price, mark_price, liq_price, leverage, updated_at)
        VALUES (
          ${order.channelId}, ${order.symbol}, ${order.tradeId}::uuid, ${order.side}::side_t,
          ${order.qty}::numeric, ${order.price}::numeric, ${order.price}::numeric, ${order.liqPrice}::numeric,
          ${order.leverage}::numeric, now()
        )
        ON CONFLICT (channel_id, symbol) DO UPDATE SET
          trade_id = EXCLUDED.trade_id,
          side = EXCLUDED.side,
          size = positions.size + EXCLUDED.size,
          avg_price = (COALESCE(positions.avg_price, 0) * positions.size + EXCLUDED.avg_price * EXCLUDED.size)
                      / NULLIF(positions.size + EXCLUDED.size, 0),
          mark_price = EXCLUDED.mark_price,
          liq_price = EXCLUDED.liq_price,
          leverage = EXCLUDED.leverage,
          updated_at = now()
      `.execute(tx)
    }

    if (order.stopLoss !== undefined) {
      // Critical C1 адверсариального ревью (p3-core-fix-report.md): паритет с BybitAdapter —
      // тот же linkId 'sl'/index 0, что раньше писал отдельный вызов setStopLoss(), теперь
      // атомарно вместе со входом. DryRunAdapter не ходит к бирже вовсе, поэтому здесь просто
      // строка orders(purpose='sl') + positions.stop_loss, идентично прежнему поведению
      // setStopLoss (см. ниже) — только МОМЕНТ вызова меняется, не эффект.
      const slLinkId = buildLinkId(order, 'sl', 0)
      await tx
        .insertInto('orders')
        .values({
          trade_id: order.tradeId,
          action_id: order.actionId,
          channel_id: order.channelId,
          symbol: order.symbol,
          order_link_id: slLinkId,
          purpose: 'sl',
          side: order.side,
          order_type: 'limit',
          reduce_only: true,
          qty: order.qty,
          price: order.stopLoss,
          status: 'submitted',
          submitted_at: new Date(),
        })
        .onConflict((oc) => oc.column('order_link_id').doNothing())
        .execute()

      await tx
        .updateTable('positions')
        .set({ stop_loss: order.stopLoss, updated_at: new Date() })
        .where('channel_id', '=', order.channelId)
        .where('symbol', '=', order.symbol)
        .execute()
    }

    return { orderId: inserted.id, orderLinkId: linkId }
  }

  async placeTpLadder(tx: Kysely<DB>, params: PlaceTpLadderParams): Promise<{ orderIds: string[] }> {
    const orderIds: string[] = []

    // Последовательно (не Promise.all): каждая цель — независимый orderLinkId/строка orders,
    // но общий tx делает параллельные insert'ы избыточным риском без выигрыша в скорости —
    // ладдер обычно 2-5 целей, не тысяча.
    for (const tp of params.tps) {
      const linkId = buildLinkId(params, 'tp', tp.index)

      const inserted = await tx
        .insertInto('orders')
        .values({
          trade_id: params.tradeId,
          action_id: params.actionId,
          channel_id: params.channelId,
          symbol: params.symbol,
          order_link_id: linkId,
          purpose: 'tp',
          side: params.side,
          order_type: 'limit',
          reduce_only: true,
          qty: tp.qty,
          price: tp.price,
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
    const linkId = buildLinkId(params, 'sl', 0)

    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: params.tradeId,
        action_id: params.actionId,
        channel_id: params.channelId,
        symbol: params.symbol,
        order_link_id: linkId,
        purpose: 'sl',
        side: params.side,
        // Реальный SL — trading-stop Full (design spec §9), не отдельный ордер на бирже;
        // здесь фиксируем как reduceOnly-запись для единообразия аудита orders/orderLinkId.
        order_type: 'limit',
        reduce_only: true,
        qty: params.qty,
        price: params.price,
        status: 'submitted',
        submitted_at: new Date(),
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) {
      return { orderId: await findOrderId(tx, linkId) }
    }

    await tx
      .updateTable('positions')
      .set({ stop_loss: params.price, updated_at: new Date() })
      .where('channel_id', '=', params.channelId)
      .where('symbol', '=', params.symbol)
      .execute()

    return { orderId: inserted.id }
  }

  async closePosition(tx: Kysely<DB>, params: ClosePositionParams): Promise<{ orderId: string }> {
    const linkId = buildLinkId(params, 'close', params.seq ?? 0)

    const inserted = await tx
      .insertInto('orders')
      .values({
        trade_id: params.tradeId,
        action_id: params.actionId,
        channel_id: params.channelId,
        symbol: params.symbol,
        order_link_id: linkId,
        purpose: 'close',
        side: params.side,
        order_type: 'market',
        reduce_only: true,
        qty: params.qty,
        status: 'filled',
        submitted_at: new Date(),
        filled_at: new Date(),
      })
      .onConflict((oc) => oc.column('order_link_id').doNothing())
      .returning('id')
      .executeTakeFirst()

    if (!inserted) {
      return { orderId: await findOrderId(tx, linkId) }
    }

    const position = await tx
      .selectFrom('positions')
      .select(['size', 'avg_price'])
      .where('channel_id', '=', params.channelId)
      .where('symbol', '=', params.symbol)
      .executeTakeFirstOrThrow(
        () => new Error(`closePosition: нет строки positions для channel=${params.channelId} symbol=${params.symbol}`),
      )
    if (position.avg_price === null) {
      // Позиция с size>0, но без зафиксированного входа — противоречивое состояние (в Ф1 сюда
      // приводит только placeEntry, который всегда пишет avg_price вместе с size).
      throw new Error(`closePosition: positions.avg_price = NULL для channel=${params.channelId} symbol=${params.symbol}`)
    }

    // Нельзя закрыть больше, чем реально есть в позиции — клампим запрошенный qty её size'ом.
    const closeQty = Decimal.min(new Decimal(params.qty), new Decimal(position.size))
    const newSize = Decimal.max(0, new Decimal(position.size).minus(closeQty))

    await insertSimulatedExecution(tx, {
      orderId: inserted.id,
      tradeId: params.tradeId,
      legId: null,
      orderLinkId: linkId,
      symbol: params.symbol,
      side: params.side,
      qty: closeQty.toString(),
      price: position.avg_price,
    })

    await tx
      .updateTable('positions')
      .set({ size: newSize.toString(), updated_at: new Date() })
      .where('channel_id', '=', params.channelId)
      .where('symbol', '=', params.symbol)
      .execute()

    if (newSize.isZero()) {
      // Владение символом освобождается только при ПОЛНОМ закрытии (research
      // backend-architecture.md §"Инициатор переходов": "position.size→0 ⇒ released_at=now()").
      await releaseSymbol(tx, { channelId: params.channelId, symbol: params.symbol })
    }

    return { orderId: inserted.id }
  }

  /** В dry_run биржи нет — снимать нечего (ордера живут только в нашей таблице, их закрывает
   *  сам DryRunAdapter). Метод существует ради единого контракта ExecutionPort. */
  async cancelAllForSymbol(_symbol: string): Promise<void> {
    // no-op
  }

  async cancelOrder(tx: Kysely<DB>, params: CancelOrderParams): Promise<void> {
    await tx
      .updateTable('orders')
      .set({ status: 'cancelled', cancelled_at: new Date() })
      .where('order_link_id', '=', params.orderLinkId)
      // Уже исполненный/уже отменённый ордер не трогаем — cancelOrder идемпотентен, а не
      // затирает историческое состояние (filled НИКОГДА не должен стать cancelled).
      .where('status', '!=', 'filled')
      .where('status', '!=', 'cancelled')
      .execute()
  }
}

/** orderLinkId({mode:'dry_run', ...}) — DryRunAdapter всегда строит ключ с префиксом 'D'. */
function buildLinkId(ctx: OrderContext, purpose: OrderPurpose, legIndex: number): string {
  return orderLinkId({
    mode: 'dry_run',
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

interface SimulatedExecutionParams {
  orderId: string
  tradeId: string
  legId: string | null
  orderLinkId: string
  symbol: string
  side: Side
  qty: string
  price: string
}

/**
 * Пишет строку executions для симулированного (dry-run) филла. bybit_exec_id детерминирован
 * из orderLinkId (`sim-<orderLinkId>`) — UNIQUE-ограничение той же природы, что и order_link_id
 * само по себе гарантирует уникальность (orderLinkId уже уникален per orders.order_link_id).
 */
async function insertSimulatedExecution(tx: Kysely<DB>, params: SimulatedExecutionParams): Promise<void> {
  await tx
    .insertInto('executions')
    .values({
      order_id: params.orderId,
      trade_id: params.tradeId,
      leg_id: params.legId,
      bybit_exec_id: `sim-${params.orderLinkId}`,
      order_link_id: params.orderLinkId,
      symbol: params.symbol,
      side: params.side,
      exec_qty: params.qty,
      exec_price: params.price,
      exec_ts: new Date(),
    })
    .execute()
}
