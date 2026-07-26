// CLI управления субаккаунтами Bybit по каналам: `pnpm channel:keys` (корневой package.json ->
// scripts/channel-keys.mjs -> `node --import tsx src/channel-keys-cli.ts` с cwd=apps/engine — тот
// же приём, что и cleanup-dryrun-cli.ts: только так резолвятся workspace-пакеты api/shared).
//
// ПОЧЕМУ CLI, А НЕ АДМИНКА (design §2): секрет Bybit не должен идти через браузер, прокси и логи
// запросов. Записывает ключи только тот, у кого есть доступ к серверу и ENCRYPTION_KEY.
//
// Команды:
//   pnpm channel:keys --list
//   pnpm channel:keys --channel 1 --key <apiKey> --secret <apiSecret> [--sub-uid <uid>]
//   pnpm channel:keys --channel 1 --key <apiKey>            (секрет спросится в stdin, без эха)
//   pnpm channel:keys --channel 1 --clear
//
// Ключ ВСЕГДА проверяется живым `GET /v5/account/wallet-balance` до записи: битые/чужой сети/без
// прав ключи иначе всплыли бы только при старте движка — канал молча перестал бы торговать.
//
// Вся логика записи — в bybit/channel-keys.ts (setChannelKeys/clearChannelKeys/listChannelAccounts,
// тестируются без сети); здесь — разбор аргументов, живая проверка и печать.

import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { createDb } from 'api/db/database.js'
import type { Network } from 'shared/domain.js'
import { BybitRestClient } from './bybit/rest-client.js'
import { accountFingerprint } from './runtime/account-registry.js'
import { clearChannelKeys, listChannelAccounts, setChannelKeys } from './bybit/channel-keys.js'

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

interface Args {
  channel: number | null
  key: string | null
  secret: string | null
  subUid: number | null
  clear: boolean
  list: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { channel: null, key: null, secret: null, subUid: null, clear: false, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`channel:keys: у аргумента ${arg} нет значения`)
      i += 1
      return value
    }
    switch (arg) {
      case '--channel':
        args.channel = Number(next())
        break
      case '--key':
        args.key = next()
        break
      case '--secret':
        args.secret = next()
        break
      case '--sub-uid':
        args.subUid = Number(next())
        break
      case '--clear':
        args.clear = true
        break
      case '--list':
        args.list = true
        break
      default:
        throw new Error(`channel:keys: неизвестный аргумент ${arg}`)
    }
  }
  return args
}

const USAGE = `Использование:
  pnpm channel:keys --list
  pnpm channel:keys --channel <id> --key <apiKey> [--secret <apiSecret>] [--sub-uid <uid>]
  pnpm channel:keys --channel <id> --clear`

/** Живая проверка ключа: он должен работать в ТОЙ ЖЕ сети, в которой торгует движок. */
async function verifyKeys(network: Network, apiKey: string, apiSecret: string): Promise<string> {
  const rest = new BybitRestClient({ apiKey, apiSecret, network })
  await rest.syncClock()
  const balance = await rest.getWalletBalance()
  return balance.totalEquity || balance.totalAvailableBalance || '0'
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[channel:keys] DATABASE_URL не задан — скопируйте .env.example в .env')
    process.exitCode = 1
    return
  }

  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[channel:keys] ${String(err instanceof Error ? err.message : err)}\n${USAGE}`)
    process.exitCode = 1
    return
  }

  const db = createDb(databaseUrl)
  try {
    if (args.list || (args.channel === null && !args.clear)) {
      if (!args.list) {
        console.error(`[channel:keys] не указан --channel\n${USAGE}\n`)
        process.exitCode = 1
      }
      const rows = await listChannelAccounts(db)
      console.log('Каналы и их аккаунты Bybit:')
      for (const row of rows) {
        const account = row.ownAccount ? `свой субаккаунт${row.subUid !== null ? ` (uid ${row.subUid})` : ''}` : 'общий (BYBIT_API_KEY)'
        console.log(`  #${row.id} ${row.key}${row.title ? ` «${row.title}»` : ''} [${row.status}] -> ${account}`)
      }
      return
    }

    const channelId = args.channel
    if (channelId === null || !Number.isFinite(channelId)) {
      console.error(`[channel:keys] --channel должен быть числом\n${USAGE}`)
      process.exitCode = 1
      return
    }

    if (args.clear) {
      await clearChannelKeys(db, channelId)
      console.log(`[channel:keys] канал ${channelId} возвращён на общий аккаунт из BYBIT_API_KEY`)
      return
    }

    const apiKey = args.key
    if (!apiKey) {
      console.error(`[channel:keys] не указан --key\n${USAGE}`)
      process.exitCode = 1
      return
    }

    // Секрет в argv виден в истории оболочки и в `ps` — если его не передали, спрашиваем в stdin.
    let apiSecret = args.secret
    if (!apiSecret) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      apiSecret = (await rl.question('API secret (ввод не отображается в истории оболочки): ')).trim()
      rl.close()
    }
    if (!apiSecret) {
      console.error('[channel:keys] пустой секрет — ключи не записаны')
      process.exitCode = 1
      return
    }

    const network = (process.env.BYBIT_NETWORK ?? 'demo') as Network
    let equity: string
    try {
      equity = await verifyKeys(network, apiKey, apiSecret)
    } catch (err) {
      // Не пишем непроверенный ключ: иначе канал молча перестанет торговать при следующем старте.
      console.error(`[channel:keys] ключ отвергнут сетью ${network}: ${String(err instanceof Error ? err.message : err)}`)
      process.exitCode = 1
      return
    }

    await setChannelKeys(db, channelId, { apiKey, apiSecret, subUid: args.subUid })
    console.log(
      `[channel:keys] канал ${channelId} -> аккаунт ${accountFingerprint(apiKey)} (${network}), equity ${equity}. ` +
        'Изменение подхватится при следующем старте движка (реестр аккаунтов строится на старте).',
    )
  } finally {
    await db.destroy()
  }
}

// Автозапуск ТОЛЬКО как entrypoint: main-live.test.ts импортирует отсюда parseArgs, и без этой
// проверки сам импорт полез бы в БД и на биржу (тот же приём, что в main.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[channel:keys] неожиданная ошибка:', err)
    process.exitCode = 1
  })
}
