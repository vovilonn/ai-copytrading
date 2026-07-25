import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import type { E2eConfig } from './env.js'

/**
 * Создание ОТДЕЛЬНОЙ сессии Telegram для постера e2e (E2E_TG_SESSION).
 *
 * ЗАЧЕМ. Первый же прогон показал: пока постер подключён с ТОЙ ЖЕ строкой сессии, что и
 * tg-ingest, воркер перестаёт получать realtime-обновления — Telegram отдаёт их последнему
 * подключившемуся, а update-loop воркера уходит в бесконечный цикл реконнектов (в логе:
 * «Closing current connection» + «реконнект: догоняем бэкфиллом»). Пост доезжал до БД только
 * после рестарта контейнера. Один auth-key на два процесса — известная граблю MTProto, и
 * лечится она не таймаутами, а вторым auth-key.
 *
 * КАК. Второй auth-key того же аккаунта заводится без SMS: это ровно тот же обмен, что и вход
 * по QR-коду в Telegram Desktop — новый клиент просит login-token, а УЖЕ АВТОРИЗОВАННАЯ сессия
 * (TG_SESSION) его принимает (auth.acceptLoginToken). Ни номера, ни кода из SMS не требуется,
 * аккаунт остаётся тот же (юзербот так же админ в тестовых каналах).
 *
 * 2FA: если на аккаунте включён облачный пароль, Telegram потребует его после принятия токена —
 * положите его в E2E_TG_2FA_PASSWORD (используется только здесь, при создании сессии).
 */

export interface CreateSessionResult {
  session: string
  user: string
  writtenTo: string | null
}

export async function createPosterSession(config: E2eConfig, options: { write: boolean }): Promise<CreateSessionResult> {
  const { apiId, apiHash, session } = config.telegram

  const main = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 })
  main.setLogLevel(LogLevel.ERROR)
  const fresh = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })
  fresh.setLogLevel(LogLevel.ERROR)

  await main.connect()
  if (!(await main.isUserAuthorized())) {
    throw new Error('e2e: TG_SESSION не авторизована — сначала `pnpm tg:login`')
  }

  try {
    await fresh.connect()
    const user = (await fresh.signInUserWithQrCode(
      { apiId, apiHash },
      {
        // Вместо показа QR-кода человеку — тот же токен сразу принимает наша живая сессия.
        qrCode: async ({ token }) => {
          await main.invoke(new Api.auth.AcceptLoginToken({ token }))
        },
        password: async () => {
          const password = process.env.E2E_TG_2FA_PASSWORD
          if (!password) {
            throw new Error(
              'e2e: на аккаунте включён облачный пароль (2FA) — положите его в E2E_TG_2FA_PASSWORD и повторите `pnpm e2e session`',
            )
          }
          return password
        },
        onError: async (err: Error) => {
          throw err
        },
      },
    )) as Api.User

    const sessionString = String(fresh.session.save())
    const writtenTo = options.write ? await writeEnv(sessionString) : null
    return {
      session: sessionString,
      user: [user.firstName, user.lastName].filter(Boolean).join(' ') + (user.username ? ` (@${user.username})` : ''),
      writtenTo,
    }
  } finally {
    await fresh.disconnect().catch(() => undefined)
    await fresh.destroy().catch(() => undefined)
    await main.disconnect().catch(() => undefined)
    await main.destroy().catch(() => undefined)
  }
}

/** Дописывает/заменяет строку E2E_TG_SESSION в корневом .env, не трогая остальные значения. */
async function writeEnv(sessionString: string): Promise<string> {
  const envPath = path.join(fileURLToPath(new URL('../../../', import.meta.url)), '.env')
  const current = await fs.readFile(envPath, 'utf8')
  const line = `E2E_TG_SESSION=${sessionString}`
  const next = /^E2E_TG_SESSION=.*$/m.test(current)
    ? current.replace(/^E2E_TG_SESSION=.*$/m, line)
    : `${current.trimEnd()}\n\n# Отдельная сессия Telegram для постера e2e (создана \`pnpm e2e session\`) — тот же\n# аккаунт, но свой auth-key: с общей сессией tg-ingest перестаёт получать realtime.\n${line}\n`
  await fs.writeFile(envPath, next, 'utf8')
  return envPath
}
