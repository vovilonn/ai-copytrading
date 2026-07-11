import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Decimal } from 'decimal.js'
import { BybitRestClient } from '../src/bybit/rest-client.js'
import { orderLinkId } from '../src/execution/order-link-id.js'
import { floorTo } from '../src/risk/leverage.js'

// Живой e2e-сценарий Ф3 задачи 6 (task-6-brief.md): реальные ордера на Bybit testnet малым
// notional (~$10-20) через BybitRestClient НАПРЯМУЮ (брифом разрешено "BybitAdapter +
// BybitRestClient напрямую или через pipeline"; выбран прямой REST — без БД/пайплайна тест
// чище всего проверяет именно живое поведение БИРЖИ: вход с атомарным SL (Critical C1
// адверсариального ревью p3-core-fix-report.md — этот путь ещё НИ РАЗУ не проверялся живым
// исполненным ордером), TP-лесенку, перенос SL, частичное/полное закрытие и идемпотентность
// 110072 (research bybit-execution.md §16 отмечал оба этих факта как "непроверяемо без мутаций").
//
// Символ SOLUSDT (не BTCUSDT): цена ~$78 на testnet -> qty=0.2 (qtyStep=0.1) даёт notional
// ~$15.6 — комфортно в целевом диапазоне $10-20 и выше minNotional=5. qtyStep/tickSize/
// minNotional сверены и с локальной таблицей instruments, и напрямую с живым
// GET /v5/market/instruments-info?symbol=SOLUSDT перед написанием теста (см. p3-task6-report.md).
//
// Тест устойчив к тому, что testnet может двигаться/флейкать: каждый шаг ПЕРЕЧИТЫВАЕТ живое
// состояние (getPositions/getOpenOrders) вместо того, чтобы полагаться на значение из прошлого
// шага (TP теоретически мог исполниться раньше срока при движении рынка) — CLEANUP в afterAll
// выполняется ВСЕГДА, каждый его сетевой вызов обёрнут в try/catch и только логирует, никогда
// не бросает (см. бриф: "лови ошибки, логируй, но CLEANUP всегда").

const BYBIT_LIVE_TESTS = process.env.BYBIT_LIVE_TESTS === '1'
if (!BYBIT_LIVE_TESTS) {
  console.warn('[live-e2e.test] живой e2e пропущен; задайте BYBIT_LIVE_TESTS=1 для запуска (СТАВИТ РЕАЛЬНЫЕ ОРДЕРА на testnet)')
}
const describeLive = BYBIT_LIVE_TESTS ? describe : describe.skip

const SYMBOL = 'SOLUSDT'
const QTY_STEP = new Decimal('0.1')
const TICK_SIZE = new Decimal('0.01')
const LEVERAGE = '5'
const ENTRY_QTY = '0.2' // ~$15 notional при цене ~$78 (qtyStep=0.1, minNotional=5)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Округление вниз к шагу — та же функция (risk/leverage.ts), что использует BybitAdapter,
 *  переиспользуем вместо копии (DRY, CLAUDE.md): floor безопасен для qty и для price здесь —
 *  тест не оптимизирует направление исполнения, только валидность "кратно тику". */
function roundDown(value: Decimal, step: Decimal): string {
  return floorTo(step, value).toString()
}

// Один и тот же тестовый прогон -> один RUN_ID (Date.now()), не пересекается с прошлыми/будущими
// прогонами и с dry-run/live orderLinkId движка (channelOrd=99 зарезервирован только за e2e-тестом).
const RUN_ID = Date.now()
function linkId(purpose: 'entry' | 'tp' | 'close', legIndex: number): string {
  return orderLinkId({ mode: 'live', channelOrd: 99, tgMessageId: RUN_ID, actionIndex: 0, purpose, legIndex })
}

/**
 * Живая цена символа через ПУБЛИЧНЫЙ (без подписи) `GET /v5/market/tickers` — обнаружено при
 * подготовке этого теста: `position/list` стаб-позиция (size=0) в ТЕКУЩЕМ состоянии testnet-
 * аккаунта отдаёт markPrice='' (пустую строку), а НЕ живую цену, вопреки допущению research
 * bybit-execution.md §1 (на которое опирается и main.ts::getMarkPrice гейта slippage — см.
 * список сомнений в p3-task6-report.md). Публичный тикер не требует API-ключа и надёжно отдаёт
 * markPrice независимо от того, есть ли позиция/история по символу на аккаунте.
 */
async function fetchPublicMarkPrice(symbol: string): Promise<Decimal> {
  const res = await fetch(`https://api-testnet.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`)
  const body = (await res.json()) as { retCode: number; retMsg: string; result: { list: Array<{ markPrice: string }> } }
  if (body.retCode !== 0) throw new Error(`fetchPublicMarkPrice(${symbol}): retCode=${body.retCode} (${body.retMsg})`)
  const markPrice = body.result.list[0]?.markPrice
  if (!markPrice || Number(markPrice) <= 0) throw new Error(`fetchPublicMarkPrice(${symbol}): пустой/невалидный markPrice в ответе`)
  return new Decimal(markPrice)
}

describeLive('Живой E2E на Bybit testnet (Ф3, задача 6, требует BYBIT_LIVE_TESTS=1)', () => {
  let client: BybitRestClient
  let markPrice: Decimal
  let entrySizeAfterEntry = '0'

  const entryLinkId = linkId('entry', 0)
  const tp1LinkId = linkId('tp', 0)
  const tp2LinkId = linkId('tp', 1)
  const partialCloseLinkId = linkId('close', 0)
  const fullCloseLinkId = linkId('close', 1)

  beforeAll(async () => {
    const apiKey = process.env.BYBIT_API_KEY
    const apiSecret = process.env.BYBIT_API_SECRET
    const network = process.env.BYBIT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    if (!apiKey || !apiSecret) {
      throw new Error('BYBIT_LIVE_TESTS=1, но BYBIT_API_KEY/BYBIT_API_SECRET не заданы в .env')
    }
    if (network !== 'testnet') {
      // Защита от несчастного случая: этот файл ставит РЕАЛЬНЫЕ ордера, отказ работать не на testnet.
      throw new Error('live-e2e.test: BYBIT_NETWORK должен быть testnet — отказ ставить ордера иначе')
    }
    client = new BybitRestClient({ apiKey, apiSecret, network })

    markPrice = await fetchPublicMarkPrice(SYMBOL)
    console.log(`[live-e2e][setup] markPrice(${SYMBOL})=${markPrice.toString()} RUN_ID=${RUN_ID} entryLinkId=${entryLinkId}`)
  })

  afterAll(async () => {
    // CLEANUP — обязателен НЕЗАВИСИМО от того, как прошли шаги выше (бриф: "аккаунт после
    // теста — чистый: 0 позиций, 0 ордеров"). Каждый вызов — отдельный try/catch: один сбойный
    // шаг очистки не должен отменить остальные.
    console.log('[live-e2e][cleanup] начало...')

    try {
      await client.cancelAll(SYMBOL)
      console.log('[live-e2e][cleanup] cancelAll(SYMBOL) до закрытия остатка — OK')
    } catch (err) {
      console.error('[live-e2e][cleanup] cancelAll (шаг 1) не удался:', err)
    }

    try {
      const positions = await client.getPositions(SYMBOL)
      const pos = positions.find((p) => new Decimal(p.size).gt(0))
      if (pos) {
        const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy'
        const result = await client.createOrder({
          symbol: SYMBOL,
          side: closeSide,
          orderType: 'Market',
          qty: pos.size,
          orderLinkId: linkId('close', 999),
          reduceOnly: true,
          positionIdx: 0,
        })
        console.log('[live-e2e][cleanup] закрыт остаток позиции size=%s ->', pos.size, JSON.stringify(result))
        await sleep(1500)
      } else {
        console.log('[live-e2e][cleanup] позиция уже размера 0 — закрывать нечего')
      }
    } catch (err) {
      console.error('[live-e2e][cleanup] закрытие остатка позиции не удалось:', err)
    }

    try {
      await client.cancelAll(SYMBOL)
      console.log('[live-e2e][cleanup] финальный cancelAll(SYMBOL) — OK')
    } catch (err) {
      console.error('[live-e2e][cleanup] финальный cancelAll не удался:', err)
    }

    try {
      const finalPositions = await client.getPositions(SYMBOL)
      const finalOrders = await client.getOpenOrders(SYMBOL)
      const finalSize = finalPositions.find((p) => new Decimal(p.size).gt(0))?.size ?? '0'
      console.log(`[live-e2e][cleanup] ФИНАЛЬНОЕ СОСТОЯНИЕ: position.size=${finalSize} openOrders=${finalOrders.length}`)
      if (finalSize !== '0' || finalOrders.length !== 0) {
        console.error('[live-e2e][cleanup] ВНИМАНИЕ: аккаунт НЕ чист после cleanup — нужен ручной разбор testnet-аккаунта!')
      }
    } catch (err) {
      console.error('[live-e2e][cleanup] финальная проверка состояния не удалась:', err)
    }
  })

  it('шаг 1: вход market с атомарным SL -> позиция size>0, наш orderLinkId (K), SL выставлен', async () => {
    await client.switchMode(SYMBOL, 0) // one-way — идемпотентно (110025 проглочен rest-client'ом)
    await client.setLeverage(SYMBOL, LEVERAGE) // идемпотентно (110043 проглочен)

    const slPrice = roundDown(markPrice.mul(0.95), TICK_SIZE) // 5% ниже — не триггерит немедленно
    const result = await client.createOrder({
      symbol: SYMBOL,
      side: 'Buy',
      orderType: 'Market',
      qty: ENTRY_QTY,
      orderLinkId: entryLinkId,
      positionIdx: 0,
      stopLoss: slPrice,
      slTriggerBy: 'LastPrice',
    })
    console.log('[live-e2e][шаг1] createOrder(entry, stopLoss=%s) =', slPrice, JSON.stringify(result))
    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(false)
    expect(result.orderId).not.toBe('')

    await sleep(2000) // время на обработку market-филла биржей
    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))
    console.log('[live-e2e][шаг1] getPositions после входа =', JSON.stringify(pos))
    expect(pos, 'ожидали открытую позицию после market-входа').toBeDefined()
    expect(pos!.side).toBe('Buy')
    expect(new Decimal(pos!.size).gte(QTY_STEP)).toBe(true)
    expect(Number(pos!.stopLoss)).toBeGreaterThan(0)
    entrySizeAfterEntry = pos!.size
  })

  it('шаг 1b: идемпотентность — повторный createOrder с ТЕМ ЖЕ orderLinkId -> 110072, второго ордера нет', async () => {
    const slPrice = roundDown(markPrice.mul(0.95), TICK_SIZE)
    const retry = await client.createOrder({
      symbol: SYMBOL,
      side: 'Buy',
      orderType: 'Market',
      qty: ENTRY_QTY,
      orderLinkId: entryLinkId, // ТОТ ЖЕ ключ, что и в шаге 1 — имитация ретрая после «краша»
      positionIdx: 0,
      stopLoss: slPrice,
      slTriggerBy: 'LastPrice',
    })
    console.log('[live-e2e][шаг1b] повторный createOrder(entry, тот же orderLinkId) =', JSON.stringify(retry))
    expect(retry.idempotent).toBe(true)
    expect(retry.orderId).toBe('')

    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))
    console.log('[live-e2e][шаг1b] позиция после повторного вызова, size =', pos?.size)
    // Размер позиции НЕ удвоился — второго реального входа на бирже не произошло.
    expect(pos?.size).toBe(entrySizeAfterEntry)

    const executions = await client.getExecutions({ orderLinkId: entryLinkId, symbol: SYMBOL })
    const totalExecQty = executions.reduce((sum, e) => sum.plus(e.execQty), new Decimal(0))
    console.log(`[live-e2e][шаг1b] getExecutions(orderLinkId=entry) count=${executions.length} totalExecQty=${totalExecQty.toString()}`)
    expect(totalExecQty.toString()).toBe(new Decimal(entrySizeAfterEntry).toString())
  })

  it('шаг 2: TP-лесенка — 2 reduceOnly лимитки видны в order/realtime', async () => {
    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))
    expect(pos, 'нужна открытая позиция перед TP-лесенкой').toBeDefined()
    const half = roundDown(new Decimal(pos!.size).div(2), QTY_STEP)

    const tp1Price = roundDown(markPrice.mul(1.05), TICK_SIZE)
    const tp2Price = roundDown(markPrice.mul(1.08), TICK_SIZE)

    const r1 = await client.createOrder({
      symbol: SYMBOL,
      side: 'Sell',
      orderType: 'Limit',
      qty: half,
      price: tp1Price,
      orderLinkId: tp1LinkId,
      reduceOnly: true,
      timeInForce: 'GTC',
      positionIdx: 0,
    })
    const r2 = await client.createOrder({
      symbol: SYMBOL,
      side: 'Sell',
      orderType: 'Limit',
      qty: half,
      price: tp2Price,
      orderLinkId: tp2LinkId,
      reduceOnly: true,
      timeInForce: 'GTC',
      positionIdx: 0,
    })
    console.log('[live-e2e][шаг2] TP1(price=%s,qty=%s) =', tp1Price, half, JSON.stringify(r1))
    console.log('[live-e2e][шаг2] TP2(price=%s,qty=%s) =', tp2Price, half, JSON.stringify(r2))
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    await sleep(1000)
    const openOrders = await client.getOpenOrders(SYMBOL)
    const ourTps = openOrders.filter((o) => o.orderLinkId === tp1LinkId || o.orderLinkId === tp2LinkId)
    console.log('[live-e2e][шаг2] getOpenOrders (наши TP) =', JSON.stringify(ourTps))
    expect(ourTps.length).toBe(2)
  })

  it('шаг 3: перенос SL — setTradingStop с новым stopLoss обновляет позицию', async () => {
    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))
    expect(pos, 'нужна открытая позиция перед переносом SL').toBeDefined()

    const newSl = roundDown(markPrice.mul(0.97), TICK_SIZE) // подтянули ближе к цене (было 0.95), но всё ещё ниже
    const result = await client.setTradingStop({
      symbol: SYMBOL,
      positionIdx: 0,
      tpslMode: 'Full',
      stopLoss: newSl,
      slTriggerBy: 'LastPrice',
      slSize: pos!.size,
    })
    console.log('[live-e2e][шаг3] setTradingStop(stopLoss=%s) =', newSl, JSON.stringify(result))
    expect(result.ok).toBe(true)

    await sleep(1000)
    const after = await client.getPositions(SYMBOL)
    const updated = after.find((p) => new Decimal(p.size).gt(0))
    console.log('[live-e2e][шаг3] позиция после переноса SL, stopLoss =', updated?.stopLoss)
    expect(updated, 'позиция должна остаться открытой после переноса SL').toBeDefined()
    expect(Number(updated!.stopLoss)).toBe(Number(newSl))
  })

  it('шаг 4: частичное закрытие reduceOnly market -> size уменьшился, execution.closedSize>0', async () => {
    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))
    expect(pos, 'нужна открытая позиция перед частичным закрытием').toBeDefined()
    const sizeBefore = new Decimal(pos!.size)
    const partialQty = roundDown(sizeBefore.div(2), QTY_STEP)

    if (new Decimal(partialQty).lte(0)) {
      // Остаток равен ровно одному шагу qtyStep (напр. TP уже съел половину раньше срока) —
      // частичное закрытие ниже minQty невозможно, тест это не считает провалом (см. заголовок
      // файла про устойчивость к движению рынка), шаг 5 закроет остаток целиком.
      console.warn(`[live-e2e][шаг4] остаток ${sizeBefore.toString()} слишком мал для частичного закрытия — пропуск, закроет шаг 5`)
      return
    }

    const result = await client.createOrder({
      symbol: SYMBOL,
      side: 'Sell',
      orderType: 'Market',
      qty: partialQty,
      orderLinkId: partialCloseLinkId,
      reduceOnly: true,
      positionIdx: 0,
    })
    console.log('[live-e2e][шаг4] partial close createOrder(qty=%s) =', partialQty, JSON.stringify(result))
    expect(result.ok).toBe(true)

    await sleep(2000)
    const after = await client.getPositions(SYMBOL)
    const posAfter = after.find((p) => new Decimal(p.size).gt(0))
    console.log(`[live-e2e][шаг4] size до=${sizeBefore.toString()} qty=${partialQty} size после=${posAfter?.size ?? '0'}`)
    expect(new Decimal(posAfter?.size ?? '0').lt(sizeBefore)).toBe(true)

    const executions = await client.getExecutions({ orderLinkId: partialCloseLinkId, symbol: SYMBOL })
    const closedSize = executions.reduce((sum, e) => sum.plus(e.closedSize || '0'), new Decimal(0))
    console.log(`[live-e2e][шаг4] getExecutions(partial close) count=${executions.length} closedSize=${closedSize.toString()}`)
    expect(closedSize.gt(0)).toBe(true)
  })

  it('шаг 5: полное закрытие остатка -> size=0, висящие TP сняты cancel-all', async () => {
    const positions = await client.getPositions(SYMBOL)
    const pos = positions.find((p) => new Decimal(p.size).gt(0))

    if (pos) {
      const result = await client.createOrder({
        symbol: SYMBOL,
        side: 'Sell',
        orderType: 'Market',
        qty: pos.size,
        orderLinkId: fullCloseLinkId,
        reduceOnly: true,
        positionIdx: 0,
      })
      console.log('[live-e2e][шаг5] full close createOrder(qty=%s) =', pos.size, JSON.stringify(result))
      expect(result.ok).toBe(true)
      await sleep(2000)
    } else {
      console.log('[live-e2e][шаг5] позиция уже закрыта (шаг 4 закрыл всё) — переходим к снятию TP')
    }

    const after = await client.getPositions(SYMBOL)
    const posAfter = after.find((p) => new Decimal(p.size).gt(0))
    console.log('[live-e2e][шаг5] позиция после полного закрытия, size =', posAfter?.size ?? '0')
    expect(posAfter).toBeUndefined()

    // Висящие TP не снимаются автоматически полным закрытием (research §5) — cancel-all по
    // символу, тот же путь, что private-ws.ts::applyPositionPush делает при живом пуше position size->0.
    await client.cancelAll(SYMBOL)
    await sleep(1000)
    const openOrders = await client.getOpenOrders(SYMBOL)
    console.log('[live-e2e][шаг5] getOpenOrders после cancel-all =', JSON.stringify(openOrders))
    expect(openOrders.length).toBe(0)
  })
})
