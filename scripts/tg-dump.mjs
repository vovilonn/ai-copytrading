#!/usr/bin/env node
/**
 * Выгружает последние сообщения каналов-источников для анализа форматов сигналов.
 *
 * Результат: temp/tg-dump/<channel>/messages.jsonl + media/<id>.<ext>.
 * temp/ лежит в .gitignore — сообщения чужих каналов в репозиторий не попадают.
 */
import { mkdir, writeFile } from 'node:fs/promises'

import { CHANNELS, createClient, fetchMessages } from './lib/tg.mjs'

const LIMIT = Number(process.env.TG_DUMP_LIMIT ?? 100)
const OUT_ROOT = new URL('../temp/tg-dump/', import.meta.url)

function mediaKind(message) {
  const media = message.media
  if (!media) return null
  const name = media.className ?? ''
  if (name === 'MessageMediaPhoto') return 'photo'
  if (name === 'MessageMediaDocument') return media.document?.mimeType ?? 'document'
  return name
}

async function dumpChannel(client, channel) {
  const dir = new URL(`${channel.key}/`, OUT_ROOT)
  const mediaDir = new URL('media/', dir)
  await mkdir(mediaDir, { recursive: true })

  const messages = await fetchMessages(client, channel, LIMIT)
  console.log(`\n${channel.label}: получено ${messages.length} сообщений`)

  const records = []
  let downloaded = 0

  for (const message of messages) {
    const kind = mediaKind(message)
    let mediaFile = null

    if (kind === 'photo') {
      try {
        const buffer = await client.downloadMedia(message, {})
        if (buffer?.length) {
          mediaFile = `media/${message.id}.jpg`
          await writeFile(new URL(mediaFile, dir), buffer)
          downloaded += 1
        }
      } catch (error) {
        console.log(`  ! не скачал медиа ${message.id}: ${error.message}`)
      }
    }

    records.push({
      id: message.id,
      date: new Date(message.date * 1000).toISOString(),
      text: message.message ?? '',
      media: kind,
      mediaFile,
      groupedId: message.groupedId ? String(message.groupedId) : null,
      replyToMsgId: message.replyTo?.replyToMsgId ?? null,
      fwdFrom: message.fwdFrom ? String(message.fwdFrom.fromName ?? message.fwdFrom.fromId ?? '') : null,
      views: message.views ?? null,
    })
  }

  // Сортируем от старых к новым — так удобнее читать диалог сигналов.
  records.reverse()
  await writeFile(new URL('messages.jsonl', dir), records.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const withText = records.filter((r) => r.text.trim()).length
  const withPhoto = records.filter((r) => r.media === 'photo').length
  const albums = new Set(records.filter((r) => r.groupedId).map((r) => r.groupedId)).size
  console.log(`  текст: ${withText} · фото: ${withPhoto} (скачано ${downloaded}) · альбомов: ${albums}`)
  console.log(`  → temp/tg-dump/${channel.key}/messages.jsonl`)
}

async function main() {
  const client = createClient()
  await client.connect()

  if (!(await client.isUserAuthorized())) {
    console.error('\n✖ Нет активной сессии. Сначала выполните: pnpm tg:login\n')
    process.exit(1)
  }

  for (const channel of CHANNELS) {
    try {
      await dumpChannel(client, channel)
    } catch (error) {
      console.error(`\n✖ ${channel.label}: ${error.message}`)
    }
  }

  await client.disconnect()
  console.log()
}

await main()
