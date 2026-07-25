import { Decimal } from 'decimal.js'
import { BybitRestClient, type Order, type Position } from 'engine/bybit/rest-client.js'
import type { E2eConfig } from './env.js'

/**
 * Живое состояние demo-аккаунта Bybit и его выравнивание между сценариями.
 *
 * Клиент — тот же BybitRestClient, которым торгует движок (DRY: подпись, rate-limit, коды
 * идемпотентности живут в одном месте). Прямые ордера отсюда ставятся ТОЛЬКО на закрытие
 * (`flatten`): открывает позиции исключительно бот — иначе e2e проверял бы сам себя.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Префикс orderLinkId уборочных ордеров — чтобы их нельзя было спутать с ордерами движка
 *  (тот строит ключ как `K<ord>-<msg>-<idx>-<purpose><leg>`, order-link-id.ts). */
const CLEANUP_LINK_PREFIX = 'E2ECLEAN'

export interface ExchangeSnapshot {
  /** totalEquity аккаунта — ровно та величина, которой движок сайзит риск (state/equity.ts). */
  totalEquity: string
  usdtBalance: string
  positions: Array<{ symbol: string; side: string; size: string; avgPrice: string; stopLoss: string; takeProfit: string }>
  orders: Array<{ symbol: string; orderLinkId: string; side: string; qty: string; price: string; reduceOnly: boolean; status: string }>
}

export function createRest(config: E2eConfig): BybitRestClient {
  return new BybitRestClient({
    apiKey: config.bybit.apiKey,
    apiSecret: config.bybit.apiSecret,
    network: config.network,
  })
}

export async function snapshot(rest: BybitRestClient, symbol?: string): Promise<ExchangeSnapshot> {
  const [wallet, positions, orders] = await Promise.all([
    rest.getWalletBalance(),
    rest.getPositions(symbol),
    rest.getOpenOrders(symbol),
  ])
  const usdt = wallet.coins.find((c) => c.coin === 'USDT')
  return {
    totalEquity: wallet.totalEquity,
    usdtBalance: usdt?.walletBalance ?? '0',
    positions: positions
      .filter((p) => new Decimal(p.size || '0').gt(0))
      .map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        avgPrice: p.avgPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
      })),
    orders: orders.map((o) => ({
      symbol: o.symbol,
      orderLinkId: o.orderLinkId,
      side: o.side,
      qty: o.qty,
      price: o.price,
      reduceOnly: o.reduceOnly,
      status: o.orderStatus,
    })),
  }
}

export async function markPrice(rest: BybitRestClient, symbol: string): Promise<string> {
  const ticker = await rest.getTicker(symbol)
  // markPrice — та же величина, по которой движок считает гейт slippage (main.ts::createMarkPriceGetter).
  const price = ticker.markPrice || ticker.lastPrice
  if (!price || new Decimal(price).lte(0)) throw new Error(`e2e: пустой markPrice для ${symbol}`)
  return price
}

export async function positionOf(rest: BybitRestClient, symbol: string): Promise<Position | null> {
  const positions = await rest.getPositions(symbol)
  return positions.find((p) => new Decimal(p.size || '0').gt(0)) ?? null
}

export async function openOrdersOf(rest: BybitRestClient, symbol: string): Promise<Order[]> {
  return rest.getOpenOrders(symbol)
}

export interface FlattenResult {
  closed: Array<{ symbol: string; side: string; size: string }>
  cancelledSymbols: string[]
  leftovers: string[]
}

/**
 * Приводит аккаунт к нулю: снимает все ордера и закрывает все позиции рынком (reduceOnly).
 *
 * Порядок «сначала cancelAll, потом закрытие, потом cancelAll ещё раз» — не паранойя: висящие
 * reduceOnly-лимитки TP не снимаются автоматически при закрытии позиции (research §5, тот же
 * порядок в apps/engine/test/live-e2e.test.ts), а закрытие рынком может частично исполнить TP.
 */
export async function flatten(rest: BybitRestClient, symbols?: string[]): Promise<FlattenResult> {
  const targets = symbols && symbols.length > 0 ? symbols : undefined
  const closed: FlattenResult['closed'] = []
  const cancelledSymbols: string[] = []

  const positions = (await Promise.all((targets ?? [undefined]).map((s) => rest.getPositions(s)))).flat()
  const orders = (await Promise.all((targets ?? [undefined]).map((s) => rest.getOpenOrders(s)))).flat()
  const symbolsToClean = [
    ...new Set([
      ...positions.filter((p) => new Decimal(p.size || '0').gt(0)).map((p) => p.symbol),
      ...orders.map((o) => o.symbol),
    ]),
  ]

  for (const symbol of symbolsToClean) {
    await rest.cancelAll(symbol).catch(() => undefined)
    cancelledSymbols.push(symbol)
  }

  for (const position of positions) {
    if (new Decimal(position.size || '0').lte(0)) continue
    const closeSide = position.side === 'Buy' ? 'Sell' : 'Buy'
    await rest.createOrder({
      symbol: position.symbol,
      side: closeSide,
      orderType: 'Market',
      qty: position.size,
      // Уникальность ключа обязательна: повтор того же orderLinkId Bybit отвергает как дубль
      // (110072) — уборка второго прогона по тому же символу просто не сработала бы.
      orderLinkId: `${CLEANUP_LINK_PREFIX}-${Date.now()}-${position.symbol}`.slice(0, 36),
      reduceOnly: true,
      positionIdx: 0,
    })
    closed.push({ symbol: position.symbol, side: position.side, size: position.size })
  }

  if (closed.length > 0) {
    await sleep(2000) // время бирже на исполнение market-закрытий
    for (const symbol of [...new Set(closed.map((c) => c.symbol))]) {
      await rest.cancelAll(symbol).catch(() => undefined)
    }
  }

  const leftovers: string[] = []
  for (const symbol of symbolsToClean) {
    const still = await positionOf(rest, symbol)
    if (still) leftovers.push(`${symbol} size=${still.size}`)
  }
  return { closed, cancelledSymbols, leftovers }
}

/**
 * Ждёт, пока состояние позиции на бирже удовлетворит предикату. Нужен потому, что ордер уходит
 * синхронно внутри обработки сообщения, а филл/позиция появляются асинхронно (приватный WS
 * движка увидит их спустя доли секунды — биржа тоже отвечает не мгновенно).
 */
export async function waitForPosition(
  rest: BybitRestClient,
  symbol: string,
  predicate: (position: Position | null) => boolean,
  timeoutMs = 20_000,
  intervalMs = 1000,
): Promise<Position | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const position = await positionOf(rest, symbol)
    if (predicate(position) || Date.now() >= deadline) return position
    await sleep(intervalMs)
  }
}
