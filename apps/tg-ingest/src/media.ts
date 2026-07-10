import { Api } from 'telegram'

/** Что передать в client.downloadMedia вторым аргументом. */
export type DownloadHint =
  | { kind: 'photo'; options: Record<string, never> }
  | { kind: 'video-thumb'; options: { thumb: Api.TypePhotoSize } }

/**
 * Видео в vision не отправить, поэтому берём статический thumbnail.
 * ВНИМАНИЕ: downloadMedia(msg, {thumb: -1}) качает ВЕСЬ mp4, а не превью —
 * нужен именно элемент thumbs с className === 'PhotoSize'.
 * Фото Telegram и так крошечные (~98 КБ / 1128 px), ресайз не нужен.
 */
export function pickMedia(media: Api.TypeMessageMedia | undefined): DownloadHint | null {
  if (media instanceof Api.MessageMediaPhoto) {
    return { kind: 'photo', options: {} }
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    if (!(doc instanceof Api.Document)) return null
    if (!doc.mimeType?.startsWith('video/')) return null // стикеры и прочее пропускаем
    const thumb = doc.thumbs?.find((t) => t.className === 'PhotoSize')
    return thumb ? { kind: 'video-thumb', options: { thumb } } : null
  }
  return null
}
