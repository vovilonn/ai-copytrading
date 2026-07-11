// Ключи Bybit per-channel с фолбэком на env (Ф3, задача 5, task-5-brief.md): "Ключи Bybit — из
// env (BYBIT_API_KEY/SECRET), либо per-channel из channels.bybit_api_key_enc (с фолбэком на env,
// если субаккаунт не заведён)". В Ф3 у ВСЕХ каналов bybit_api_key_enc/bybit_api_secret_enc — NULL
// (channel-seed.service.ts сознательно пишет null, провижининг субаккаунтов — design plan
// "что осознанно не делается в Ф3") — поэтому сегодня этот путь всегда возвращает env-ключи. Но
// структура (расшифровка через ENCRYPTION_KEY) готова к моменту, когда админ-UI заведёт субаккаунт
// каналу — сигнатура getChannelKeys уже не изменится.
//
// Формат шифрования: AES-256-GCM, ключ — `ENCRYPTION_KEY` из .env (64 hex-символа = 32 байта,
// см. .env.example), хранимая строка — `<iv:12байт-hex>:<authTag:16байт-hex>:<ciphertext-hex>`.
// encryptSecret экспортирована ради тестов этого файла (и будущего admin-UI, который сегодня ещё
// не пишет эту колонку) — единственный способ получить валидную зашифрованную строку без живого UI.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'

const ALGORITHM = 'aes-256-gcm'
// GCM: 12 байт — рекомендованная (и наиболее совместимая) длина nonce.
const IV_LENGTH = 12

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) {
    throw new Error('channel-keys: ENCRYPTION_KEY не задан в env — расшифровка ключей канала невозможна')
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== 32) {
    throw new Error(`channel-keys: ENCRYPTION_KEY должен декодироваться в 32 байта (64 hex-символа), получено ${key.length} байт`)
  }
  return key
}

/** Шифрует секрет (api key/secret Bybit) под ENCRYPTION_KEY — для тестов/будущего admin-UI. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

/** Расшифровывает строку, произведённую `encryptSecret` (или будущим admin-UI тем же форматом). */
export function decryptSecret(encoded: string): string {
  const key = getEncryptionKey()
  const parts = encoded.split(':')
  if (parts.length !== 3) {
    throw new Error('channel-keys: некорректный формат зашифрованного секрета (ожидается iv:authTag:ciphertext)')
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string]
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()])
  return plaintext.toString('utf8')
}

export interface ChannelKeys {
  apiKey: string
  apiSecret: string
}

/**
 * Ключи Bybit для канала: `channels.bybit_api_key_enc`/`bybit_api_secret_enc` (расшифровка), с
 * фолбэком на `BYBIT_API_KEY`/`BYBIT_API_SECRET` из env, если у канала обе колонки NULL (субаккаунт
 * не заведён). `channelId=null` — глобальный вызов БЕЗ привязки к конкретному каналу (main.ts:
 * единый REST/приватный WS-клиент движка в Ф3 — "один аккаунт на все каналы", design plan
 * "что осознанно не делается в Ф3": провижининг субаккаунтов не запускается) — пропускает поход
 * в БД и сразу берёт env.
 */
export async function getChannelKeys(db: Kysely<DB>, channelId: number | null): Promise<ChannelKeys> {
  if (channelId !== null) {
    const channel = await db
      .selectFrom('channels')
      .select(['bybit_api_key_enc', 'bybit_api_secret_enc'])
      .where('id', '=', channelId)
      .executeTakeFirst()
    if (channel?.bybit_api_key_enc && channel?.bybit_api_secret_enc) {
      return { apiKey: decryptSecret(channel.bybit_api_key_enc), apiSecret: decryptSecret(channel.bybit_api_secret_enc) }
    }
  }

  const apiKey = process.env.BYBIT_API_KEY
  const apiSecret = process.env.BYBIT_API_SECRET
  if (!apiKey || !apiSecret) {
    throw new Error(
      `getChannelKeys: ни субаккаунт канала${channelId !== null ? ` ${channelId}` : ''}, ни BYBIT_API_KEY/BYBIT_API_SECRET (env) не заданы`,
    )
  }
  return { apiKey, apiSecret }
}
