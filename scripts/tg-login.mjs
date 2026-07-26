#!/usr/bin/env node
/**
 * Интерактивный вход в Telegram по номеру телефона.
 *
 * Сохраняет StringSession в .env как TG_SESSION и проверяет доступ к каналам,
 * из которых бот будет читать сигналы. Строка сессии равносильна полному доступу
 * к аккаунту — она пишется только в .env, который лежит в .gitignore.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { CHANNELS, resolveChannel, describeChannel } from './lib/tg.mjs'

import pkg from 'telegram'
import sessions from 'telegram/sessions/index.js'

const { TelegramClient } = pkg
const { StringSession } = sessions

const ENV_PATH = new URL('../.env', import.meta.url)

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

/** Записывает KEY=value в .env, заменяя существующую строку или дописывая в конец. */
async function upsertEnv(key, value) {
  const raw = await readFile(ENV_PATH, 'utf8')
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  const next = pattern.test(raw) ? raw.replace(pattern, line) : `${raw.trimEnd()}\n\n${line}\n`
  await writeFile(ENV_PATH, next, { mode: 0o600 })
}

async function checkAccess(client, channel) {
  try {
    const entity = await resolveChannel(client, channel)
    console.log(`  ✔ ${await describeChannel(client, channel, entity)}`)
    return true
  } catch (error) {
    console.log(`  ✖ ${channel.label}\n      ${error.message}`)
    return false
  }
}

async function main() {
  const apiId = Number(process.env.TG_APP_API_ID)
  const apiHash = process.env.TG_APP_API_HASH
  if (!apiId || !apiHash) fail('TG_APP_API_ID / TG_APP_API_HASH не заданы в .env')

  const rl = createInterface({ input: stdin, output: stdout })
  const ask = (question) => rl.question(question)

  // ВСЕГДА пустая сессия — это команда ВХОДА, она обязана заводить НОВЫЙ auth-key.
  //
  // Раньше сюда подставлялась строка из .env, и это делало невозможным ровно тот случай, ради
  // которого команду и запускают: если Telegram отозвал ключ (`AUTH_KEY_DUPLICATED` — одну строку
  // сессии использовали с двух машин), клиент падал на первом же запросе, не дойдя до вопроса про
  // номер. Проверить УЖЕ работающую сессию можно `pnpm tg:chats` — здесь для этого делать нечего.
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  })

  console.log('\nВход в Telegram. Номер — в международном формате, например +79991234567.\n')
  console.log('Заводится НОВАЯ строка сессии; прежняя (в .env) будет заменена.')
  console.log('Держите отдельные строки сессии для прода и для локальной машины: один и тот же')
  console.log('auth-key с двух IP Telegram отзывает без предупреждения.\n')

  await client.start({
    phoneNumber: () => ask('Номер телефона: '),
    phoneCode: () => ask('Код из Telegram: '),
    password: () => ask('Пароль 2FA (если включён): '),
    onError: (error) => console.error(`  Telegram: ${error.message}`),
  })

  rl.close()

  const me = await client.getMe()
  console.log(`\n✔ Вход выполнен: ${me.firstName ?? ''} ${me.lastName ?? ''} (@${me.username ?? 'без username'})`)

  await upsertEnv('TG_SESSION', client.session.save())
  console.log('  Сессия сохранена в .env как TG_SESSION (файл в .gitignore).')

  console.log('\nПроверяю доступ к каналам:')
  const results = []
  for (const channel of CHANNELS) results.push(await checkAccess(client, channel))

  await client.disconnect()

  if (results.some((ok) => !ok)) {
    fail('К части каналов нет доступа. Подпишитесь на них этим аккаунтом и запустите скрипт снова.')
  }
  console.log('\n✔ Доступ ко всем каналам есть. Дальше: pnpm tg:dump\n')
}

await main()
