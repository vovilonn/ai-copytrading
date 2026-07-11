import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network, Side, OrderPurpose } from 'shared/domain.js'
import type { BybitRestClient } from '../bybit/rest-client.js'
import type { ExecutionMode } from './order-link-id.js'
import { DryRunAdapter } from './dry-run.adapter.js'
import { BybitAdapter } from './bybit.adapter.js'

// ExecutionPort — единственная точка ветвления dry_run/live (design spec §14): вся остальная
// логика (риск, сайзинг, парсинг) работает ОДИНАКОВО в обоих режимах и вызывает только этот
// интерфейс. В Ф1 единственная реализация — DryRunAdapter (эта же ветка); BybitAdapter — Ф3.

/**
 * Координаты, общие для ЛЮБОГО метода порта. channelOrd/tgMessageId/actionIndex — то, из чего
 * orderLinkId() строит детерминированный ключ идемпотентности (order-link-id.ts); channelId/
 * actionId/tradeId — реальные FK схемы (orders.channel_id/action_id/trade_id, миграция 001).
 * actionId ОБЯЗАТЕЛЕН: orders.action_id в схеме NOT NULL (в отличие от черновика в брифе задачи,
 * где EntryOrder его не перечислял) — к моменту вызова порта action уже создан парсером/оркестратором.
 */
export interface OrderContext {
  /** channels.id — FK (не путать с channelOrd ниже). */
  channelId: number
  /** channels.ord — ординал канала, часть orderLinkId (order-link-id.ts). */
  channelOrd: number
  /** Telegram message id сообщения-источника действия. */
  tgMessageId: number
  /** Индекс действия внутри сообщения (несколько ордеров в одном сообщении). */
  actionIndex: number
  /** actions.id — FK, orders.action_id NOT NULL по схеме. */
  actionId: string
  /** trades.id — сделка, к которой относится ордер. */
  tradeId: string
  symbol: string
  side: Side
}

export interface EntryOrder extends OrderContext {
  /** 'entry' — первый вход, 'add' — доливка (research §9, order-link-id.ts). */
  purpose: Extract<OrderPurpose, 'entry' | 'add'>
  orderType: 'market' | 'limit'
  /** Decimal-строка, не number (CLAUDE.md: деньги/qty — строки). */
  qty: string
  /**
   * Decimal-строка — цена лимитки ИЛИ симулированная цена филла для market-ордера.
   * ОБЯЗАТЕЛЬНА для обоих orderType (отступление от черновика брифа, где price? опционален):
   * DryRunAdapter не имеет в Ф1 живого фида цен (см. task-6-brief.md — mark_price=avg_price
   * "на момент открытия"), поэтому не может симулировать market-филл без переданной цены —
   * её вызывающая сторона берёт из распарсенного сигнала/текущего mark (задача 9).
   */
  price: string
  leverage: string
  /** trade_legs.id — лега (entry/add), которую заполняет этот ордер. */
  legId: string
  /**
   * Симулированная цена ликвидации на выбранном плече (task-11-brief.md, полировка А):
   * risk/leverage.ts liqPrice({entry,side,lev,mmr}) — та же формула, что pipeline.ts уже
   * считает ДО этого вызова для гейта "safeStop" (проверка, что SL за ликвидацией). Передаём
   * готовое значение сюда, а не пересчитываем внутри адаптера — избегаем второго похода за mmr.
   */
  liqPrice: string
}

/** Одна цель TP-лесенки (design spec §9 / research bybit-execution.md §4: reduceOnly limit). */
export interface TpTarget {
  price: string
  qty: string
  /** Индекс цели в tps[] сообщения — тот же legIndex, что уходит в orderLinkId и orders.tp_index. */
  index: number
}

export interface PlaceTpLadderParams extends OrderContext {
  tps: readonly TpTarget[]
}

export interface SetStopLossParams extends OrderContext {
  price: string
  qty: string
}

export interface ClosePositionParams extends OrderContext {
  qty: string
}

export interface CancelOrderParams {
  orderLinkId: string
}

export interface ExecutionPort {
  placeEntry(tx: Kysely<DB>, order: EntryOrder): Promise<{ orderId: string; orderLinkId: string }>
  placeTpLadder(tx: Kysely<DB>, params: PlaceTpLadderParams): Promise<{ orderIds: string[] }>
  setStopLoss(tx: Kysely<DB>, params: SetStopLossParams): Promise<{ orderId: string }>
  closePosition(tx: Kysely<DB>, params: ClosePositionParams): Promise<{ orderId: string }>
  cancelOrder(tx: Kysely<DB>, params: CancelOrderParams): Promise<void>
}

/**
 * Зависимости порта. DryRunAdapter (Ф1) не обращается к сети — оба поля игнорирует. BybitAdapter
 * (Ф3, задача 2) требует REST-клиент Bybit и сеть (testnet/mainnet) — оба поля здесь опциональны
 * (dry_run их не использует), но фабрика ниже требует их ФАКТИЧЕСКИ для mode==='live' и бросает
 * явную ошибку, если их нет — тихий запуск BybitAdapter с "undefined" сетью/клиентом был бы хуже,
 * чем explicit throw на старте.
 */
export interface ExecutionPortDeps {
  rest?: BybitRestClient
  network?: Network
}

/**
 * Фабрика — единственное место, где строка EXECUTION_MODE превращается в конкретный адаптер
 * (design spec §14). Вызывающий код (оркестратор исполнения) не импортирует DryRunAdapter/
 * BybitAdapter напрямую, только createExecutionPort + интерфейс ExecutionPort.
 */
export function createExecutionPort(mode: ExecutionMode, deps: ExecutionPortDeps = {}): ExecutionPort {
  switch (mode) {
    case 'dry_run':
      return new DryRunAdapter()
    case 'live':
      if (!deps.rest || !deps.network) {
        // Тихий фолбэк здесь означал бы реальные деньги без корректно настроенного клиента —
        // явный throw на старте вместо неопределённого поведения при первом же вызове порта.
        throw new Error("createExecutionPort: mode 'live' требует deps.rest (BybitRestClient) и deps.network")
      }
      return new BybitAdapter(deps.rest, deps.network)
  }
}
