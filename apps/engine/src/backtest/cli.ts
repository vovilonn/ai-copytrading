import { config as loadDotenv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import type { Network } from 'shared/domain.js'
import { KlineSource, type KlineInterval } from './kline-source.js'
import { formatReport, replay, type ReplayOptions } from './replay.js'

/**
 * CLI реплей-бэктеста: `pnpm backtest <channel> [флаги]`. Печатает отчёт (таблица причин + числа).
 * Запускается из apps/engine (через scripts/backtest.mjs -> `node --import tsx`), чтобы резолвились
 * workspace-пакеты (api/shared) и зависимости движка (pg/kysely).
 */

// .env лежит в корне репозитория (та же схема, что main.ts) — грузим явно, если ещё не подхвачен.
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) })

interface Args {
  channelKey: string
  from?: Date
  to?: Date
  network?: Network
  equity?: string
  slippage?: string
  simulatePnl: boolean
  horizonDays?: number
  interval?: KlineInterval
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const [k, inlineV] = a.slice(2).split('=', 2)
      if (inlineV !== undefined) flags.set(k!, inlineV)
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags.set(k!, argv[++i]!)
      else flags.set(k!, 'true')
    } else {
      positional.push(a)
    }
  }
  const channelKey = positional[0]
  if (!channelKey) throw new Error('usage: pnpm backtest <channelId|channelKey> [--from ISO] [--to ISO] [--network demo|testnet|mainnet] [--equity N] [--slippage PCT] [--no-pnl] [--horizon DAYS] [--interval 1|5|15|60]')
  const from = flags.get('from')
  const to = flags.get('to')
  const args: Args = {
    channelKey,
    simulatePnl: flags.get('no-pnl') !== 'true' && flags.get('pnl') !== 'false',
  }
  if (from) args.from = new Date(from)
  if (to) args.to = new Date(to)
  const network = flags.get('network')
  if (network) args.network = network as Network
  const equity = flags.get('equity')
  if (equity) args.equity = equity
  const slippage = flags.get('slippage')
  if (slippage) args.slippage = slippage
  const horizon = flags.get('horizon')
  if (horizon) args.horizonDays = Number(horizon)
  const interval = flags.get('interval')
  if (interval) args.interval = interval as KlineInterval
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const cacheFile = process.env.BACKTEST_KLINE_CACHE || undefined
  const kline = new KlineSource(cacheFile ? { cacheFile } : {})

  const options: ReplayOptions = {
    channelKey: args.channelKey,
    kline,
    simulatePnl: args.simulatePnl,
  }
  if (args.from) options.from = args.from
  if (args.to) options.to = args.to
  if (args.network) options.network = args.network
  if (args.equity) options.equity = args.equity
  if (args.slippage) options.maxEntrySlippagePct = args.slippage
  if (args.horizonDays !== undefined) options.pnlHorizonDays = args.horizonDays
  if (args.interval) options.pnlInterval = args.interval

  const report = await replay(options)
  console.log(formatReport(report))
  // Полный JSON — для машинного разбора/архива отчёта (после человекочитаемой таблицы).
  console.log('\n--- JSON ---')
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error('[backtest] фатальная ошибка:', err)
  process.exitCode = 1
})
