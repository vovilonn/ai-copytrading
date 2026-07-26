#!/usr/bin/env node
/**
 * Заводит ДОПОЛНИТЕЛЬНУЮ строку сессии Telegram для того же аккаунта — без кода из SMS.
 *
 * ЗАЧЕМ. Одна строка сессии = один auth-key. Использовать один ключ с двух машин нельзя: Telegram
 * отзывает его без предупреждения (`406 AUTH_KEY_DUPLICATED`), и обе машины разом слепнут — ровно
 * это случилось 26.07.2026, когда прод и ноутбук работали с общей строкой. Правильно — своя строка
 * на каждое окружение: прод, локальная разработка, e2e-постер.
 *
 * КАК. Новый клиент начинает вход по QR-токену, а подтверждает этот токен УЖЕ АВТОРИЗОВАННАЯ
 * сессия (`--approver`) — тот же приём, что и `pnpm e2e session`. Человеку ничего вводить не надо,
 * кроме облачного пароля, если он включён (берётся из TG_2FA_PASSWORD/E2E_TG_2FA_PASSWORD).
 *
 * Использование:
 *   pnpm tg:session                       # печатает новую строку в stdout
 *   pnpm tg:session --out /tmp/prod.txt   # кладёт в файл (не светится в истории терминала)
 *   pnpm tg:session --approver E2E_TG_SESSION
 */
import { writeFile } from 'node:fs/promises'
import pkg from 'telegram'
import sessions from 'telegram/sessions/index.js'
import { Api } from 'telegram'
import { LogLevel } from 'telegram/extensions/Logger.js'

const { TelegramClient } = pkg
const { StringSession } = sessions

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { approver: 'TG_SESSION', out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--approver') args.approver = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else fail(`неизвестный аргумент ${arg}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiId = Number(process.env.TG_APP_API_ID)
  const apiHash = process.env.TG_APP_API_HASH
  if (!apiId || !apiHash) fail('TG_APP_API_ID / TG_APP_API_HASH не заданы в .env')

  const approverSession = process.env[args.approver]
  if (!approverSession) fail(`${args.approver} не задана в .env — нечем подтвердить вход (сначала pnpm tg:login)`)

  const approver = new TelegramClient(new StringSession(approverSession), apiId, apiHash, { connectionRetries: 5 })
  approver.setLogLevel(LogLevel.ERROR)
  const fresh = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })
  fresh.setLogLevel(LogLevel.ERROR)

  await approver.connect()
  if (!(await approver.isUserAuthorized())) {
    fail(`${args.approver} не авторизована (возможно, ключ отозван) — выполните pnpm tg:login`)
  }

  try {
    await fresh.connect()
    const user = await fresh.signInUserWithQrCode(
      { apiId, apiHash },
      {
        // Вместо показа QR-кода человеку — тот же токен сразу принимает живая сессия.
        qrCode: async ({ token }) => {
          await approver.invoke(new Api.auth.AcceptLoginToken({ token }))
        },
        password: async () => {
          const password = process.env.TG_2FA_PASSWORD ?? process.env.E2E_TG_2FA_PASSWORD
          if (!password) fail('на аккаунте включён облачный пароль — положите его в TG_2FA_PASSWORD и повторите')
          return password
        },
        onError: async (err) => {
          throw err
        },
      },
    )

    const session = fresh.session.save()
    const who = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.username || 'аккаунт'
    if (args.out) {
      await writeFile(args.out, session, { mode: 0o600 })
      console.error(`✔ новая сессия для «${who}» записана в ${args.out} (права 600)`)
      console.error('  Строка равносильна полному доступу к аккаунту — не коммитьте и не пересылайте её в чатах.')
    } else {
      console.error(`✔ новая сессия для «${who}»:`)
      console.log(session)
    }
  } finally {
    await fresh.disconnect().catch(() => {})
    await approver.disconnect().catch(() => {})
  }
}

main().catch((err) => {
  console.error('\n✖ не удалось завести сессию:', err?.message ?? err)
  process.exit(1)
})
