import crypto from 'node:crypto'
import type { Api } from 'telegram'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import { pickMedia, type DownloadHint } from './media.js'
import {
  findMediaRepairCandidates,
  computeAlbumOrderIndex,
  recordMediaRepairAttempt,
  insertMediaRow,
  type IngestMediaInput,
  type MediaRepairCandidate,
} from './repository.js'
import { CHANNEL_SOURCES, type ChannelSource } from 'shared/sources.js'

export interface DownloadedMediaResult {
  storagePath: string
  bytes: number
  sha256: string
  mediaType: string
}

/**
 * Порт доступа к Telegram, отделяющий бизнес-логику ремонта от GramJS/MTProto — позволяет
 * тестировать MediaRepairService фейковым фетчером, не поднимая настоящую сессию (задача 12b,
 * тесты не должны зависеть от TG_SESSION). IngestService реализует этот интерфейс через
 * client.getMessages/downloadMedia.
 */
export interface MediaFetcher {
  /** По одному элементу на каждый id, СТРОГО в том же порядке, что и tgMessageIds — undefined
   *  на позиции означает "сообщение удалено в Telegram либо недоступно" (см. §7 research). */
  fetchMessages(source: ChannelSource, tgMessageIds: readonly number[]): Promise<Array<Api.Message | undefined>>
  downloadMedia(
    source: ChannelSource,
    msg: Api.Message,
    hint: DownloadHint,
    orderIndex: number,
  ): Promise<DownloadedMediaResult | null>
}

export interface MediaRepairOptions {
  batchSize?: number
  batchPauseMs?: number
  maxAttempts?: number
  scanLimit?: number
}

export interface MediaRepairSummary {
  scanned: number
  repaired: number
  failed: number
}

// Пачками не больше 50 (см. бриф задачи 12b) — getMessages({ids}) дешёвый, но не бесплатный,
// и агрессивный параллелизм на бэкфилле — ровно то, что ловит FloodWait.
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_BATCH_PAUSE_MS = 1000
// После 3 неудачных ремонтных попыток (по одной за периодический запуск, т.е. растянуто во
// времени — не 3 попытки подряд) считаем медиа объективно недоступным и перестаём сканировать.
const DEFAULT_MAX_ATTEMPTS = 3
// Верхняя граница на один запуск run() — снимок кандидатов берётся ОДИН раз в начале (см. ниже,
// почему не перезапрашивать БД между пачками), остаток при переполнении подберёт следующий
// периодический запуск (раз в 10 минут, ingest.service.ts).
const DEFAULT_SCAN_LIMIT = 2000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ремонтный проход (задача 12b, Critical для Ф0): находит сообщения, у которых has_media=true
 * (pickMedia() на вставке нашёл скачиваемое медиа), но строки message_media нет — сбой сети или
 * необработанный FloodWait при бэкфилле уронили закачку, и раньше это было потеряно навсегда
 * (см. .superpowers/sdd/task-12b-report.md, §"Причина"). Идемпотентен —
 * UNIQUE(message_id, order_index) в БД (002_media_repair.ts) гарантирует отсутствие дублей даже
 * при пересечении с live-потоком/повторным запуском ремонта.
 */
export class MediaRepairService {
  private readonly batchSize: number
  private readonly batchPauseMs: number
  private readonly maxAttempts: number
  private readonly scanLimit: number

  constructor(
    private readonly db: Kysely<DB>,
    private readonly fetcher: MediaFetcher,
    private readonly sources: readonly ChannelSource[] = CHANNEL_SOURCES,
    options: MediaRepairOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    this.batchPauseMs = options.batchPauseMs ?? DEFAULT_BATCH_PAUSE_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  }

  async run(): Promise<MediaRepairSummary> {
    const summary: MediaRepairSummary = { scanned: 0, repaired: 0, failed: 0 }

    // ВАЖНО: кандидаты снимаются ОДИН раз в начале run(), а не перезапрашиваются между пачками.
    // Если бы каждая пачка заново звала findMediaRepairCandidates, сообщение с постоянно
    // недоступным медиа (например удалённое в Telegram) оставалось бы кандидатом до тех пор,
    // пока не исчерпает maxAttempts, и было бы атаковано ПОВТОРНО в той же пачке того же run() —
    // все maxAttempts сгорели бы за один вызов вместо одного за периодический запуск (раз в
    // 10 минут), как задумано. Снимок фиксирует набор на момент старта: каждое сообщение
    // получает не более одной попытки за один run().
    const candidates = await findMediaRepairCandidates(this.db, this.scanLimit)
    summary.scanned = candidates.length

    for (let offset = 0; offset < candidates.length; offset += this.batchSize) {
      const chunk = candidates.slice(offset, offset + this.batchSize)

      const byChannel = new Map<number, MediaRepairCandidate[]>()
      for (const c of chunk) {
        const list = byChannel.get(c.channelId) ?? []
        list.push(c)
        byChannel.set(c.channelId, list)
      }

      for (const [channelId, group] of byChannel) {
        const result = await this.repairChannelBatch(channelId, group)
        summary.repaired += result.repaired
        summary.failed += result.failed
      }

      // Пауза между пачками — та же причина, что и в backfillSource (ingest.service.ts):
      // не бомбить Telegram запросами подряд без пауз. Не спим после последней пачки.
      const isLastChunk = offset + this.batchSize >= candidates.length
      if (!isLastChunk) await sleep(this.batchPauseMs)
    }

    return summary
  }

  private async repairChannelBatch(
    channelId: number,
    group: MediaRepairCandidate[],
  ): Promise<{ repaired: number; failed: number }> {
    const source = this.sources.find((s) => Number(s.channelId) === channelId)
    if (!source) return { repaired: 0, failed: 0 } // источник вне CHANNEL_SOURCES — не должно происходить

    const ids = group.map((c) => c.tgMessageId)
    const fetched = await this.fetcher.fetchMessages(source, ids)

    const groupedIds = [...new Set(group.map((c) => c.groupedId).filter((g): g is string => g != null))]
    const orderIndexByGroup = await computeAlbumOrderIndex(this.db, channelId, groupedIds)

    let repaired = 0
    let failed = 0

    for (let i = 0; i < group.length; i++) {
      const candidate = group[i]!
      const msg = fetched[i]

      if (!msg) {
        // Сообщение удалено в Telegram (или сервер его не вернул) — навсегда, ремонт бессилен.
        await recordMediaRepairAttempt(this.db, candidate.messageDbId, this.maxAttempts)
        failed++
        continue
      }

      const hint = pickMedia(msg.media)
      if (!hint) {
        // pickMedia — чистая функция от типа media; has_media стало true именно потому, что
        // при вставке она вернула не-null (см. ingest.service.ts persistMessage). Расхождение
        // при повторном вычислении означало бы рассинхрон данных, а не временный сбой сети —
        // защитная ветка, чтобы не крутить ремонт вечно, если такое всё же случится.
        await recordMediaRepairAttempt(this.db, candidate.messageDbId, this.maxAttempts)
        failed++
        continue
      }

      const orderIndex =
        candidate.groupedId != null
          ? (orderIndexByGroup.get(candidate.groupedId)?.get(candidate.tgMessageId) ?? 0)
          : 0

      try {
        const downloaded = await this.fetcher.downloadMedia(source, msg, hint, orderIndex)
        if (!downloaded) throw new Error('downloadMedia вернул пусто (файл недоступен)')

        const media: IngestMediaInput = {
          id: crypto.randomUUID(),
          tgMessageId: candidate.tgMessageId,
          groupedId: candidate.groupedId,
          orderIndex,
          storagePath: downloaded.storagePath,
          mediaType: downloaded.mediaType,
          bytes: downloaded.bytes,
          sha256: downloaded.sha256,
        }
        await insertMediaRow(this.db, candidate.messageDbId, media)
        repaired++
      } catch (err) {
        console.error(`[tg-ingest] ремонт медиа ${source.key}#${candidate.tgMessageId}:`, err)
        await recordMediaRepairAttempt(this.db, candidate.messageDbId, this.maxAttempts)
        failed++
      }
    }

    return { repaired, failed }
  }
}
