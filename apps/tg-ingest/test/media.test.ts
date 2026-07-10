import { it, expect } from 'vitest'
import bigInt from 'big-integer'
import { Api } from 'telegram'
import { pickMedia } from '../src/media.js'

// Конструируем настоящие экземпляры Api.* (не голые объекты с className) — pickMedia в брифе
// использует instanceof, а поля-конструкторы telegram.Api не так уж громоздки (см. отчёт).
// Поля `long` в MTProto — это BigInteger из пакета big-integer, а не нативный bigint.

it('фото → {kind: "photo"}', () => {
  const photo = new Api.Photo({
    id: bigInt(1),
    accessHash: bigInt(1),
    fileReference: Buffer.from([]),
    date: 0,
    sizes: [],
    dcId: 1,
  })
  const media = new Api.MessageMediaPhoto({ photo })

  expect(pickMedia(media)).toEqual({ kind: 'photo', options: {} })
})

it('видео video/mp4 с thumbs [PhotoStrippedSize, PhotoSize] → video-thumb, выбран именно PhotoSize', () => {
  const stripped = new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([1, 2, 3]) })
  const photoSize = new Api.PhotoSize({ type: 'm', w: 320, h: 176, size: 14000 })
  const doc = new Api.Document({
    id: bigInt(123),
    accessHash: bigInt(456),
    fileReference: Buffer.from([]),
    date: 0,
    mimeType: 'video/mp4',
    size: bigInt(4_100_000),
    dcId: 1,
    attributes: [],
    thumbs: [stripped, photoSize],
  })
  const media = new Api.MessageMediaDocument({ document: doc })

  const hint = pickMedia(media)
  expect(hint?.kind).toBe('video-thumb')
  // ВАЖНО: не 0-й элемент (PhotoStrippedSize — бесполезный превью-заглушка),
  // а именно тот, чей className === 'PhotoSize'.
  expect(hint?.kind === 'video-thumb' && hint.options.thumb).toBe(photoSize)
})

it('стикер application/x-tgsticker → null', () => {
  const doc = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(1),
    fileReference: Buffer.from([]),
    date: 0,
    mimeType: 'application/x-tgsticker',
    size: bigInt(5000),
    dcId: 1,
    attributes: [],
    thumbs: [],
  })
  const media = new Api.MessageMediaDocument({ document: doc })

  expect(pickMedia(media)).toBeNull()
})
