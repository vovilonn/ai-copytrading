// Ключи Bybit per-channel с фолбэком на env: "Ключи Bybit — из env (BYBIT_API_KEY/SECRET), либо
// per-channel из channels.bybit_api_key_enc (с фолбэком на env, если субаккаунт не заведён)".
// Канал со своими ключами торгует СВОИМ аккаунтом Bybit (реестр — runtime/account-registry.ts);
// канал без ключей — общим аккаунтом из env, ровно как до появления субаккаунтов.
//
// Ключи заводит CLI `pnpm channel:keys` (channel-keys-cli.ts -> setChannelKeys ниже), а НЕ админка:
// секрет не должен идти через браузер и логи запросов (docs/superpowers/specs/
// 2026-07-26-per-channel-subaccounts-design.md §2).
//
// Формат шифрования: AES-256-GCM, ключ — `ENCRYPTION_KEY` из .env (64 hex-символа = 32 байта,
// см. .env.example), хранимая строка — `<iv:12байт-hex>:<authTag:16байт-hex>:<ciphertext-hex>`.
// ВАЖНО: смена ENCRYPTION_KEY делает уже записанные ключи каналов нерасшифровываемыми — канал
// выпадет из реестра аккаунтов (лог + пропуск сообщений), лечится повторным `pnpm channel:keys`.

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
 * не заведён). `channelId=null` — ключи ОБЩЕГО аккаунта движка: поход в БД пропускается, сразу env
 * (реестр аккаунтов спрашивает их так, чтобы понять, свой у канала аккаунт или общий).
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

/** Строка отчёта `pnpm channel:keys --list`: какой канал каким аккаунтом торгует. */
export interface ChannelAccountRow {
  id: number
  key: string
  title: string | null
  status: string
  /** false — канал торгует общим аккаунтом из BYBIT_API_KEY. */
  ownAccount: boolean
  subUid: number | null
}

/**
 * Привязывает каналу собственный субаккаунт Bybit. Ключ и секрет шифруются под ENCRYPTION_KEY —
 * в БД открытым текстом не попадает ничего, дампы БД и бэкапы остаются безопасными.
 *
 * Проверка ключа живым запросом к бирже делается ВЫШЕ (channel-keys-cli.ts): здесь чистая запись,
 * чтобы функция тестировалась без сети.
 */
export async function setChannelKeys(
  db: Kysely<DB>,
  channelId: number,
  keys: ChannelKeys & { subUid?: number | null },
): Promise<void> {
  const result = await db
    .updateTable('channels')
    .set({
      bybit_api_key_enc: encryptSecret(keys.apiKey),
      bybit_api_secret_enc: encryptSecret(keys.apiSecret),
      ...(keys.subUid === undefined ? {} : { bybit_sub_uid: keys.subUid }),
      updated_at: new Date(),
    })
    .where('id', '=', channelId)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`setChannelKeys: канала ${channelId} нет в БД`)
  }
}

/** Возвращает канал на ОБЩИЙ аккаунт из env (обе колонки → NULL). */
export async function clearChannelKeys(db: Kysely<DB>, channelId: number): Promise<void> {
  const result = await db
    .updateTable('channels')
    .set({ bybit_api_key_enc: null, bybit_api_secret_enc: null, bybit_sub_uid: null, updated_at: new Date() })
    .where('id', '=', channelId)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows) === 0) {
    throw new Error(`clearChannelKeys: канала ${channelId} нет в БД`)
  }
}

/** Каналы и их аккаунты — БЕЗ расшифровки: сам факт наличия ключей, а не значения. */
export async function listChannelAccounts(db: Kysely<DB>): Promise<ChannelAccountRow[]> {
  const rows = await db
    .selectFrom('channels')
    .select(['id', 'key', 'title', 'status', 'bybit_api_key_enc', 'bybit_api_secret_enc', 'bybit_sub_uid'])
    .orderBy('ord')
    .execute()
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    status: row.status,
    ownAccount: row.bybit_api_key_enc !== null && row.bybit_api_secret_enc !== null,
    subUid: row.bybit_sub_uid,
  }))
}
