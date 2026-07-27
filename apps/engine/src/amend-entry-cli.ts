// CLI правки отложенного входа: `pnpm order:amend` (корневой package.json ->
// scripts/amend-entry.mjs -> `node --import tsx src/amend-entry-cli.ts` с cwd=apps/engine).
//
// Меняет объём и/или прикреплённый стоп у ещё не исполненной лимитки, сохраняя её связь со
// сделкой (Bybit держит тот же orderLinkId). Руками на бирже это делать нельзя: отдельный ордер
// исполнится «мимо наших», и сделка уйдёт в manual_override.
//
// Использование:
//   pnpm order:amend --order K02-221523-00-E0                       предпросмотр
//   pnpm order:amend --order <id> --qty 0.10 --sl 1860.1 --force
//   pnpm order:amend --order <id> --margin 20 --risk-pct 5 --force   объём из маржи, стоп из риска
//
// `--margin` считает объём как маржа × плечо сделки / цена входа; `--risk-pct` двигает стоп так,
// чтобы убыток по нему равнялся этой доле депозита. Обе цифры округляются к шагам инструмента.

import { fileURLToPath } from 'node:url'
import { Decimal } from 'decimal.js'
import { config as loadDotenv } from 'dotenv'
import { createDb } from 'api/db/database.js'
import type { Network } from 'shared/domain.js'
import { BybitRestClient } from './bybit/rest-client.js'
import { getInstrument } from './instruments.js'
import { floorTo } from './risk/leverage.js'
import { amendPendingEntry, checkAmendGuard, findPendingEntry, stopLossForRisk } from './state/amend-pending-entry.js'

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

interface Args {
  order: string | null
  qty: string | null
  sl: string | null
  margin: string | null
  riskPct: string | null
  force: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { order: null, qty: null, sl: null, margin: null, riskPct: null, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`order:amend: у аргумента ${arg} нет значения`)
      i += 1
      return value
    }
    switch (arg) {
      case '--order':
        args.order = next()
        break
      case '--qty':
        args.qty = next()
        break
      case '--sl':
        args.sl = next()
        break
      case '--margin':
        args.margin = next()
        break
      case '--risk-pct':
        args.riskPct = next()
        break
      case '--force':
        args.force = true
        break
      default:
        throw new Error(`order:amend: неизвестный аргумент ${arg}`)
    }
  }
  return args
}

const USAGE = `Использование:
  pnpm order:amend --order <orderLinkId>                                  предпросмотр
  pnpm order:amend --order <orderLinkId> [--qty N | --margin USD] [--sl PRICE | --risk-pct P] --force`

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[order:amend] DATABASE_URL не задан')
    process.exitCode = 1
    return
  }

  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[order:amend] ${String(err instanceof Error ? err.message : err)}\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (!args.order) {
    console.error(`[order:amend] не указан --order\n${USAGE}`)
    process.exitCode = 1
    return
  }

  const db = createDb(databaseUrl)
  try {
    const entry = await findPendingEntry(db, args.order)
    if (!entry) {
      console.error(`[order:amend] ордера ${args.order} нет в журнале`)
      process.exitCode = 1
      return
    }

    const network = (process.env.BYBIT_NETWORK ?? 'mainnet') as Network
    const rest = new BybitRestClient({
      apiKey: process.env.BYBIT_API_KEY!,
      apiSecret: process.env.BYBIT_API_SECRET!,
      network,
    })
    await rest.syncClock()

    const instrument = await getInstrument(db, entry.symbol, network)
    if (!instrument) {
      console.error(`[order:amend] инструмента ${entry.symbol} нет в кэше — обновите инструменты`)
      process.exitCode = 1
      return
    }

    const trade = await db
      .selectFrom('trades')
      .select(['leverage', 'side'])
      .where('id', '=', entry.tradeId)
      .executeTakeFirstOrThrow()
    const leverage = new Decimal(trade.leverage ?? '1')
    const entryPrice = new Decimal(entry.price ?? '0')

    // Объём: либо явный --qty, либо из маржи (маржа × плечо = размер позиции).
    let qty: string | undefined
    if (args.qty !== null) qty = args.qty
    else if (args.margin !== null) {
      if (entryPrice.isZero()) {
        console.error('[order:amend] у ордера нет цены входа — посчитать объём из маржи нельзя, задайте --qty')
        process.exitCode = 1
        return
      }
      qty = floorTo(instrument.qtyStep, new Decimal(args.margin).mul(leverage).div(entryPrice)).toString()
    }

    const effectiveQty = qty ?? entry.qty

    // Стоп: либо явный --sl, либо из доли депозита (двигаем стоп под нужный риск).
    let stopLoss: string | undefined
    if (args.sl !== null) stopLoss = args.sl
    else if (args.riskPct !== null) {
      const balance = await rest.getWalletBalance()
      const equity = balance.totalEquity || balance.totalAvailableBalance
      if (!equity) {
        console.error('[order:amend] биржа вернула пустой баланс — задайте --sl явной ценой')
        process.exitCode = 1
        return
      }
      const raw = stopLossForRisk({
        side: trade.side === 'short' ? 'short' : 'long',
        entry: entryPrice,
        qty: effectiveQty,
        equity,
        riskPct: args.riskPct,
      })
      stopLoss = floorTo(instrument.tickSize, raw).toString()
      console.log(`  депозит ${equity}, риск ${args.riskPct}% -> стоп ${stopLoss}`)
    }

    const notional = new Decimal(effectiveQty).mul(entryPrice)
    console.log(`Сделка ${entry.humanRef} (${entry.tradeStatus}), ордер ${args.order} [${entry.status}]`)
    console.log(`  символ ${entry.symbol} ${entry.side}, цена входа ${entry.price ?? '—'}, плечо ${leverage}`)
    console.log(`  объём:  ${entry.qty}${qty !== undefined ? ` -> ${qty}` : ' (без изменений)'}`)
    console.log(`  стоп:   ${entry.stopLoss ?? '—'}${stopLoss !== undefined ? ` -> ${stopLoss}` : ' (без изменений)'}`)
    console.log(`  позиция ${notional.toFixed(2)} USDT, маржа ${notional.div(leverage).toFixed(2)} USDT`)
    if (stopLoss !== undefined) {
      const loss = new Decimal(effectiveQty).mul(entryPrice.minus(stopLoss).abs())
      console.log(`  убыток при срабатывании стопа: ${loss.toFixed(2)} USDT`)
    }

    const guard = checkAmendGuard(entry)
    if (!guard.allowed) {
      console.error(`\n[order:amend] ОТКАЗ: ${guard.reason}`)
      process.exitCode = 1
      return
    }
    if (qty === undefined && stopLoss === undefined) {
      console.log('\nНечего менять: задайте --qty/--margin и/или --sl/--risk-pct.')
      return
    }
    if (!args.force) {
      console.log('\nЭто предпросмотр. Чтобы применить, повторите с --force')
      return
    }

    await amendPendingEntry(db, rest, entry, {
      orderLinkId: args.order,
      ...(qty !== undefined ? { qty } : {}),
      ...(stopLoss !== undefined ? { stopLoss } : {}),
    })
    console.log('\n[order:amend] ордер изменён на бирже, журнал синхронизирован.')
  } finally {
    await db.destroy()
  }
}

// Автозапуск только как entrypoint (тот же приём, что в main.ts) — тесты импортируют parseArgs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[order:amend] неожиданная ошибка:', err)
    process.exitCode = 1
  })
}
