/**
 * Общий слой для исследовательских Telegram-скриптов (tg:login, tg:dump).
 *
 * Резолв каналов идёт через getDialogs: у свежей сессии нет access_hash в кеше,
 * поэтому обратиться к каналу по «голому» id нельзя, пока диалоги не загружены.
 */
import pkg from 'telegram'
import sessions from 'telegram/sessions/index.js'

const { TelegramClient } = pkg
const { StringSession } = sessions

/** Каналы-источники сигналов. topicId задан только для форумов. */
export const CHANNELS = [
  { key: 'ch-2088626562', id: 2088626562n, label: 'канал 2088626562' },
  { key: 'ch-1962583820-t173666', id: 1962583820n, topicId: 173666, label: 'форум 1962583820, топик "A TRADING" (173666)' },
]

export function createClient() {
  const apiId = Number(process.env.TG_APP_API_ID)
  const apiHash = process.env.TG_APP_API_HASH
  const session = process.env.TG_SESSION ?? ''
  if (!apiId || !apiHash) throw new Error('TG_APP_API_ID / TG_APP_API_HASH не заданы в .env')
  return new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 })
}

let dialogsLoaded = false

/** Загружает диалоги один раз за процесс — это наполняет кеш access_hash. */
async function ensureDialogs(client) {
  if (dialogsLoaded) return
  await client.getDialogs({ limit: 500 })
  dialogsLoaded = true
}

export async function resolveChannel(client, channel) {
  await ensureDialogs(client)
  try {
    return await client.getEntity(channel.id)
  } catch {
    throw new Error(
      `не найден среди диалогов аккаунта — подпишитесь на него или проверьте id (${channel.id})`,
    )
  }
}

export async function describeChannel(client, channel, entity) {
  const messages = await client.getMessages(entity, {
    limit: 1,
    ...(channel.topicId ? { replyTo: channel.topicId } : {}),
  })
  const last = messages[0]?.date
    ? new Date(messages[0].date * 1000).toISOString()
    : 'нет доступных сообщений'
  return `${channel.label}\n      «${entity.title ?? 'без названия'}», последнее сообщение: ${last}`
}

/** Возвращает последние `limit` сообщений канала (или топика), от новых к старым. */
export async function fetchMessages(client, channel, limit) {
  const entity = await resolveChannel(client, channel)
  return client.getMessages(entity, {
    limit,
    ...(channel.topicId ? { replyTo: channel.topicId } : {}),
  })
}
