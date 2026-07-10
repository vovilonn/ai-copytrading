#!/usr/bin/env node
/**
 * Инициирует OAuth-подключение Claude-подписки к ai-proxy, запущенному в Docker.
 *
 * Прокси сам поднимает callback-приёмник на :54545 (он проброшен на loopback хоста)
 * и редиректит браузер обратно на 127.0.0.1:8317/anthropic/callback, где обменивает
 * authorization code на токены. Скрипту остаётся выдать ссылку и дождаться результата.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE_URL = process.env.AI_PROXY_URL ?? 'http://127.0.0.1:8317'
const MANAGEMENT_KEY = process.env.AI_PROXY_MANAGEMENT_KEY ?? ''
const PROVIDER = 'claude'

const HEALTH_TIMEOUT_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 2_000

// Не `--force`: этот флаг перехватил бы сам pnpm.
const relogin = process.argv.includes('--relogin')
const noBrowser = process.argv.includes('--no-browser')

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

async function management(path) {
  let response
  try {
    response = await fetch(`${BASE_URL}/v0/management${path}`, {
      headers: { 'X-Management-Key': MANAGEMENT_KEY },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (cause) {
    fail(`Не удалось обратиться к ${BASE_URL}: ${cause.message}`)
  }

  if (response.status === 401 || response.status === 403) {
    fail(
      `Management API отклонил ключ (${response.status}). ` +
        'Проверьте, что AI_PROXY_MANAGEMENT_KEY в .env совпадает с тем, ' +
        'с которым поднят контейнер: pnpm ai-proxy:down && pnpm ai-proxy:up',
    )
  }
  if (response.status === 404) {
    fail(
      'Management API не зарегистрирован. Обычно это значит, что контейнер стартовал ' +
        'без MANAGEMENT_PASSWORD. Заполните AI_PROXY_MANAGEMENT_KEY в .env и перезапустите прокси.',
    )
  }
  if (!response.ok) {
    fail(`Management API вернул ${response.status}: ${await response.text()}`)
  }

  return response.json()
}

async function findClaudeAccount() {
  const { files = [] } = await management('/auth-files')
  return files.find((file) => file.provider === PROVIDER)
}

async function waitForProxy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // прокси ещё поднимается
    }
    await sleep(1_000)
  }

  fail(`Прокси не ответил на ${BASE_URL}/healthz за ${HEALTH_TIMEOUT_MS / 1000}с. Запустите: pnpm ai-proxy:up`)
}

function openInBrowser(url) {
  const [command, args] = {
    darwin: ['open', [url]],
    // Пустая строка — заголовок окна, иначе cmd примет URL за заголовок.
    win32: ['cmd', ['/c', 'start', '', url]],
  }[process.platform] ?? ['xdg-open', [url]]

  spawn(command, args, { stdio: 'ignore', detached: true }).unref()
}

async function waitForLogin() {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const account = await findClaudeAccount()
    if (account) return account
  }

  fail(
    `Авторизация не завершилась за ${LOGIN_TIMEOUT_MS / 60_000} мин. ` +
      'Причину смотрите в логах прокси: pnpm ai-proxy:logs',
  )
}

async function main() {
  if (!MANAGEMENT_KEY) {
    fail('AI_PROXY_MANAGEMENT_KEY не задан. Скопируйте .env.example в .env и заполните его.')
  }

  await waitForProxy()

  const existing = await findClaudeAccount()
  if (existing && !relogin) {
    console.log(`✔ Claude уже подключён: ${existing.email ?? existing.name}`)
    console.log('  Повторная авторизация: pnpm ai-proxy:login --relogin')
    return
  }

  const { url } = await management('/anthropic-auth-url?is_webui=1')

  console.log('\nОткройте ссылку и подтвердите доступ под аккаунтом с Claude-подпиской:\n')
  console.log(`  ${url}\n`)

  if (noBrowser) {
    console.log('Жду callback...')
  } else {
    openInBrowser(url)
    console.log('Браузер открыт. Жду callback... (--no-browser отключает автооткрытие)')
  }

  const account = await waitForLogin()

  console.log(`\n✔ Claude подключён: ${account.email ?? account.name}`)
  console.log(`  Токены сохранены в ./.ai-proxy/auths/${account.name}`)
  console.log(`  Anthropic-совместимый эндпоинт: ${BASE_URL}/v1/messages\n`)
}

await main()
