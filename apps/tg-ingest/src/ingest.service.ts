import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { NewMessage, type NewMessageEvent, Raw } from 'telegram/events/index.js'
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js'
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { UpdateConnectionState } from 'telegram/network/index.js'
import { FloodWaitError } from 'telegram/errors/index.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { AppConfig } from 'api/config/config.schema.js'
import { topicOf } from './topic-filter.js'
import { AlbumBuffer, type AlbumMessage } from './album-buffer.js'
import { pickMedia, type DownloadHint } from './media.js'
import {
  saveAlbumWithEvent,
  advanceCursor,
  getCursor,
  type AlbumMemberInput,
  type IngestMediaInput,
} from './repository.js'
import { withDownloadRetry } from './retry.js'
import { MediaRepairService, type MediaFetcher, type DownloadedMediaResult } from './media-repair.js'
import { CHANNEL_SOURCES, type ChannelSource } from 'shared/sources.js'
import type { MessageNewPayload } from 'shared/ws-events.js'
import { mediaUrl } from 'shared/media.js'
import { DEFAULT_CHANNEL_SETTINGS } from 'shared/channel-settings.js'

// var/media лежит в корне репозитория, а не в apps/tg-ingest — путь считаем от расположения
// этого модуля (устойчиво к тому, из какого cwd запущен процесс), как и scripts/tg-dump.mjs.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MEDIA_ROOT_REL = 'var/media'

// Окно склейки альбома — см. docs/superpowers/research/telegram-ingestion.md §2.
const ALBUM_WINDOW_MS = 600
// Раз в 10 минут — подстраховка на случай, если реконнект прошёл незаметно для UpdateConnectionState.
const PERIODIC_BACKFILL_MS = 10 * 60 * 1000
// Размер страницы бэкфилла — см. §4: getHistory дёшев, 200 — безопасный батч.
const BACKFILL_PAGE_SIZE = 200

type ResolvedEntity = Api.User | Api.Chat | Api.Channel | Api.TypeUser | Api.TypeChat

interface ResolvedSource {
  source: ChannelSource
  entity: ResolvedEntity
}

interface BufferedMessage extends AlbumMessage {
  raw: Api.Message
  source: ChannelSource
}

export interface ProbedMessage {
  id: number
  text: string
  topicKind: 'root' | 'reply' | 'other'
}

/** Результат downloadMediaFile — уже скачанный и записанный на диск файл, ждущий вставки в БД. */
interface DownloadedMedia {
  relPath: string
  buffer: Buffer
  sha256: string
  kind: DownloadHint['kind']
}

/** Результат prepareMessage — готовые к сохранению данные ОДНОГО сообщения (участника
 *  альбома или одиночного сообщения, вырожденного альбома из одного элемента). Скачивание
 *  медиа (сетевой I/O) уже отработало здесь, до похода в БД (см. handleAlbum). */
interface PreparedMember {
  source: ChannelSource
  tgMessageId: number
  text: string
  msgTs: Date
  member: AlbumMemberInput
  mediaEntry: { url: string; kind: DownloadHint['kind'] } | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Снимок сообщения для колонки messages.raw — только скалярные поля, без циклических ссылок
 *  на client/entities, которые GramJS развешивает на объекте после _finishInit. */
function snapshotMessage(msg: Api.Message): Record<string, unknown> {
  return {
    id: msg.id,
    date: msg.date,
    message: msg.message ?? '',
    editDate: msg.editDate ?? null,
    groupedId: msg.groupedId ? msg.groupedId.toString() : null,
    replyTo: msg.replyTo
      ? {
          replyToMsgId: msg.replyTo.replyToMsgId ?? null,
          replyToTopId: msg.replyTo.replyToTopId ?? null,
          forumTopic: msg.replyTo.forumTopic ?? false,
        }
      : null,
    mediaClassName: msg.media?.className ?? null,
    views: msg.views ?? null,
  }
}

/** Заголовок/handle канала не зависят от конкретного варианта Entity (User/Chat/Channel) —
 *  достаём через 'in', а не приведением типов, иначе на приватных чатах получим undefined тихо. */
function entityTitle(entity: ResolvedEntity): string | null {
  return 'title' in entity && typeof entity.title === 'string' ? entity.title : null
}
function entityHandle(entity: ResolvedEntity): string | null {
  return 'username' in entity && typeof entity.username === 'string' ? entity.username : null
}

export class IngestService {
  private readonly client: TelegramClient
  private readonly albumBuffer: AlbumBuffer<BufferedMessage>
  private readonly resolved = new Map<string, ResolvedSource>() // key: channelId.toString()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly mediaRepair: MediaRepairService
  private backfillTimer: NodeJS.Timeout | null = null

  constructor(
    config: AppConfig,
    private readonly db: Kysely<DB>,
  ) {
    this.client = new TelegramClient(new StringSession(config.tgSession), config.tgApiId, config.tgApiHash, {
      // §5: реальные дефолты уже Infinity/true, но задаём явно — не полагаемся на устаревший
      // комментарий в .d.ts ("5"). floodSleepThreshold=60 — до 60с FloodWait библиotека спит сама.
      connectionRetries: Infinity,
      reconnectRetries: Infinity,
      retryDelay: 1000,
      autoReconnect: true,
      floodSleepThreshold: 60,
    })
    this.albumBuffer = new AlbumBuffer<BufferedMessage>(ALBUM_WINDOW_MS, (batch) => this.trackAlbum(batch))
    // Ремонтный проход (задача 12b) — MediaFetcher реализован ниже (mediaFetcher()) поверх
    // this.client, но MediaRepairService о GramJS ничего не знает (тестируется фейком).
    this.mediaRepair = new MediaRepairService(this.db, this.mediaFetcher(), CHANNEL_SOURCES)
  }

  /** Подключение, авторизация, прогрев access_hash, резолв источников и сид channels/channel_settings. */
  async connect(): Promise<void> {
    this.client.setLogLevel(LogLevel.WARN) // глушит benign "Error: TIMEOUT" от keepalive-пинга (§5)
    await this.client.connect()

    if (!(await this.client.isUserAuthorized())) {
      throw new Error(
        'Telegram-сессия не авторизована. Обновление TG_SESSION вне периметра этой задачи — см. pnpm tg:login.',
      )
    }

    // §10 / определение: перед getEntity(id) обязателен разовый getDialogs — иначе нет access_hash.
    await this.withFloodRetry('getDialogs', () => this.client.getDialogs({ limit: 500 }))

    for (const source of CHANNEL_SOURCES) {
      const entity = await this.resolveEntity(source.channelId)
      this.resolved.set(source.channelId.toString(), { source, entity })
      await this.seedChannel(source, entity)
    }
  }

  /** Возвращает последние `limit` сообщений топика с независимо пересчитанным topicKind —
   *  используется smoke-тестом, чтобы проверить topicOf на живых данных, а не только серверный фильтр. */
  async probeTopic(channelId: bigint, topicId: number, limit: number): Promise<ProbedMessage[]> {
    const entity = this.resolved.get(channelId.toString())?.entity ?? (await this.resolveEntity(channelId))
    const messages = await this.withFloodRetry('probeTopic', () =>
      this.client.getMessages(entity, { limit, replyTo: topicId }),
    )
    return messages.map((m) => ({
      id: m.id,
      text: m.message ?? '',
      topicKind: topicOf(m.replyTo, topicId),
    }))
  }

  /** Бэкфилл на старте, после реконнекта и периодически — catchUp() в GramJS не восстанавливает
   *  пропущенные апдейты (§5), поэтому это единственный механизм догнать пропуски. */
  async backfillAll(): Promise<void> {
    for (const source of CHANNEL_SOURCES) {
      try {
        await this.backfillSource(source)
      } catch (err) {
        this.logError(`backfill ${source.key}`, err)
      }
    }
  }

  /** Ремонтный проход (задача 12b): добирает медиа для сообщений, у которых has_media=true,
   *  но строки message_media нет (сбой сети/FloodWait на исходной вставке — см.
   *  task-12b-report.md). Запускается на старте после бэкфилла и затем периодически (§ниже). */
  async repairMissingMedia(): Promise<void> {
    const summary = await this.mediaRepair.run()
    if (summary.scanned > 0) {
      console.warn(
        `[tg-ingest] ремонт медиа: просканировано ${summary.scanned}, ` +
          `восстановлено ${summary.repaired}, не удалось ${summary.failed}`,
      )
    }
  }

  async start(): Promise<void> {
    await this.backfillAll()
    await this.repairMissingMedia().catch((err) => this.logError('repairMissingMedia (старт)', err))

    const chats = CHANNEL_SOURCES.map((s) => Number(s.channelId))

    const onIncoming = (event: NewMessageEvent | EditedMessageEvent): void => this.enqueue(event.message)
    this.client.addEventHandler(onIncoming, new NewMessage({ chats }))
    this.client.addEventHandler(onIncoming, new EditedMessage({ chats }))

    this.client.addEventHandler(
      (event: DeletedMessageEvent) => {
        this.onDeleted(event).catch((err) => this.logError('onDeleted', err))
      },
      new DeletedMessage({ chats }),
    )

    // UpdateConnectionState не имеет chatId, поэтому фильтруется по типу, а не по chats (§5, §8).
    this.client.addEventHandler(
      (update: UpdateConnectionState) => {
        if (update.state !== UpdateConnectionState.connected) return
        console.warn('[tg-ingest] реконнект: соединение восстановлено, догоняем бэкфиллом')
        this.backfillAll().catch((err) => this.logError('backfillAll (reconnect)', err))
      },
      new Raw({ types: [UpdateConnectionState] }),
    )

    this.backfillTimer = setInterval(() => {
      this.backfillAll()
        .then(() => this.repairMissingMedia())
        .catch((err) => this.logError('backfillAll/repairMissingMedia (periodic)', err))
    }, PERIODIC_BACKFILL_MS)
  }

  /** Graceful shutdown: додиспатчить недособранные альбомы, снять таймеры, закрыть соединение. */
  async stop(): Promise<void> {
    if (this.backfillTimer) {
      clearInterval(this.backfillTimer)
      this.backfillTimer = null
    }
    this.albumBuffer.drain()
    await Promise.allSettled([...this.inFlight])
    await this.client.disconnect()
    await this.client.destroy()
  }

  // ============ внутреннее ============

  private async resolveEntity(channelId: bigint): Promise<ResolvedEntity> {
    // EntityLike в типах gramjs не включает нативный bigint (только bigInt.BigInteger из
    // пакета 'big-integer'), а id каналов Ф0 заведомо меньше Number.MAX_SAFE_INTEGER —
    // конвертация в number безопасна и не требует тянуть 'big-integer' как рантайм-зависимость.
    const entity = await this.withFloodRetry('getEntity', () => this.client.getEntity(Number(channelId)))
    return Array.isArray(entity) ? entity[0]! : entity
  }

  private async seedChannel(source: ChannelSource, entity: ResolvedEntity): Promise<void> {
    const channelId = Number(source.channelId)
    const title = entityTitle(entity)
    const handle = entityHandle(entity)
    const now = new Date()

    // channels/channel_settings в DB-типах (apps/api/src/db/database.ts) не обёрнуты в Generated<>,
    // хотя в схеме у части колонок есть DEFAULT — Kysely в этом случае требует все поля явно
    // (см. комментарий у messages в database.ts). Значения ниже дублируют DEFAULT из 001_initial.ts.
    await this.db
      .insertInto('channels')
      .values({
        id: channelId,
        ord: source.ord,
        key: source.key,
        source_kind: source.sourceKind,
        topic_id: source.topicId,
        adapter_id: source.adapterId,
        title,
        handle,
        status: 'active',
        last_seen_message_id: 0,
        bybit_sub_uid: null,
        bybit_api_key_enc: null,
        bybit_api_secret_enc: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ title, handle, updated_at: new Date() }))
      .execute()

    await this.db
      .insertInto('channel_settings')
      .values({
        channel_id: channelId,
        ...DEFAULT_CHANNEL_SETTINGS,
        updated_at: new Date(),
      })
      // Сид не должен затирать настройки, выставленные оператором из админки после старта.
      .onConflict((oc) => oc.column('channel_id').doNothing())
      .execute()
  }

  private async backfillSource(source: ChannelSource): Promise<void> {
    const resolvedSource = this.resolved.get(source.channelId.toString())
    if (!resolvedSource) return // connect() ещё не отработал — backfillAll вызывается только после него

    const channelId = Number(source.channelId)
    let cursor = await getCursor(this.db, channelId)

    for (;;) {
      const batch = await this.withFloodRetry(`backfill ${source.key}`, () =>
        this.client.getMessages(resolvedSource.entity, {
          minId: cursor, // строго новее уже обработанного (§4)
          reverse: true, // от старых к новым — обрабатываем по возрастанию id (§8)
          limit: BACKFILL_PAGE_SIZE,
          waitTime: 1,
          ...(source.topicId != null ? { replyTo: source.topicId } : {}),
        }),
      )
      if (batch.length === 0) break

      for (const msg of batch) this.enqueue(msg)

      const lastId = batch[batch.length - 1]!.id
      if (lastId <= cursor) break // защита от зацикливания, если сервер вернул тот же хвост
      cursor = lastId
      if (batch.length < BACKFILL_PAGE_SIZE) break // страница не полная — дошли до текущего момента
    }
  }

  /** Общий вход для live (NewMessage/EditedMessage) и бэкфилла — единый путь склейки альбомов (§2). */
  private enqueue(msg: Api.Message): void {
    // ВАЖНО: msg.chatId — это "маркированный" id (utils.getPeerId с addMark=true даёт
    // "-100<channelId>"), а не сырой channelId, которым ключуется this.resolved и CHANNEL_SOURCES.
    // Сравнивать нужно через msg.peerId (сырой Api.PeerChannel.channelId) — иначе резолв
    // источника всегда промахивается, и enqueue тихо роняет каждое сообщение.
    const channelKey = msg.peerId instanceof Api.PeerChannel ? msg.peerId.channelId.toString() : null
    const resolvedSource = channelKey ? this.resolved.get(channelKey) : undefined
    if (!resolvedSource) return // chats-фильтр уже отсеивает чужие чаты — это подстраховка

    const { source } = resolvedSource
    if (source.topicId != null && topicOf(msg.replyTo, source.topicId) === 'other') return // §1

    this.albumBuffer.push({
      id: msg.id,
      groupedId: msg.groupedId ? msg.groupedId.toString() : null,
      raw: msg,
      source,
    })
  }

  private trackAlbum(batch: BufferedMessage[]): void {
    const task = this.handleAlbum(batch).catch((err) => this.logError('handleAlbum', err))
    this.inFlight.add(task)
    task.finally(() => this.inFlight.delete(task))
  }

  /** Задача 12c: альбом Telegram (N сообщений с общим grouped_id) должен породить РОВНО ОДНО
   *  domain_events-событие и один узел таймлайна, а не N — иначе websocket 'message.new'
   *  уходит на каждый элемент альбома и API рисует N плиток с одной фотографией вместо одной
   *  плитки с несколькими. messages уже отсортированы по id (album-buffer.ts release()) —
   *  порядок внутри группы соответствует порядку отправки, становится order_index в
   *  message_media, а первый элемент — якорь события (минимальный tg_message_id группы). */
  private async handleAlbum(messages: BufferedMessage[]): Promise<void> {
    const prepared: PreparedMember[] = []
    for (let i = 0; i < messages.length; i++) {
      const bm = messages[i]!
      try {
        prepared.push(await this.prepareMessage(bm, i))
      } catch (err) {
        this.logError(`persistMessage ${bm.source.key}#${bm.raw.id}`, err)
      }
    }
    if (prepared.length === 0) return // все участники альбома не смогли подготовиться — нечего сохранять

    const anchor = prepared[0]! // messages отсортированы по id — первый выживший и есть якорь (min tg_message_id)
    const channelId = anchor.member.channelId

    // saveAlbumWithEvent сохраняет ВСЕ строки messages/message_media альбома и не более одной
    // строки domain_events атомарно, одной транзакцией (см. repository.ts) — либо весь альбом
    // целиком закоммичен вместе с событием, либо ничего (при сбое курсор не продвинется, и
    // backfill переподхватит те же tg_message_id при следующем проходе).
    const { anyInserted } = await saveAlbumWithEvent(
      this.db,
      prepared.map((p) => p.member),
      (anchorMessageId) => {
        // payload задачи 9: готовый MessageDto (якорь + вся подпись/медиа группы) + channelId
        // (см. packages/shared/src/ws-events.ts). aiSummary/actions/method — Ф0-заглушки.
        const payload: MessageNewPayload = {
          channelId,
          message: {
            id: anchorMessageId,
            tgMessageId: anchor.tgMessageId,
            time: anchor.msgTs.toISOString(),
            // Подпись Telegram лежит ровно на одном элементе альбома (иногда её нет вовсе) —
            // берём первую непустую по порядку id, а не только якоря.
            text: prepared.map((p) => p.text).find((t) => t.trim().length > 0) ?? '',
            media: prepared.flatMap((p) => (p.mediaEntry ? [p.mediaEntry] : [])),
            aiSummary: null,
            actions: [],
            method: null,
          },
        }
        return { type: 'message.new', aggregate: 'message', payload }
      },
    )

    // Курсор двигаем для каждого участника (и для правок, и для отфильтрованных повторов) —
    // GREATEST внутри advanceCursor делает это безопасным независимо от порядка вызовов (§4).
    for (const p of prepared) {
      await advanceCursor(this.db, p.member.channelId, p.tgMessageId)
    }

    if (anyInserted) {
      // NOTIFY строго после коммита транзакции (await выше уже дождался commit) — иначе
      // слушатель на стороне api рискует получить уведомление раньше, чем строка станет видна
      // его собственному SELECT (task-9-brief §2/§3).
      await sql`SELECT pg_notify('domain_events', '')`.execute(this.db)
    }
  }

  /** Готовит одно сообщение (участника альбома или одиночное) к сохранению: скачивает медиа
   *  (сетевой I/O к Telegram, вне транзакции с БД — сбой не должен ни блокировать, ни
   *  откатывать вставку самого сообщения) и собирает данные для repository.ts. Сама вставка
   *  в БД происходит позже, одной транзакцией на весь альбом (см. handleAlbum). */
  private async prepareMessage(bm: BufferedMessage, orderIndex: number): Promise<PreparedMember> {
    const { raw: msg, source } = bm
    const hint = pickMedia(msg.media)
    const editedTs = msg.editDate ? new Date(msg.editDate * 1000) : null
    const text = msg.message ?? ''
    const msgTs = new Date(msg.date * 1000)
    // Генерируется здесь, а не в saveMessage — так payload события domain_events (в
    // handleAlbum) знает итоговый id сообщения ещё до открытия транзакции.
    const messageId = crypto.randomUUID()

    let downloaded: DownloadedMedia | null = null
    if (hint) {
      try {
        downloaded = await this.downloadMediaFile(source, msg, hint, orderIndex)
      } catch (err) {
        this.logError(`persistMedia ${source.key}#${msg.id}`, err)
      }
    }

    const mediaRowId = downloaded ? crypto.randomUUID() : null
    const media: IngestMediaInput | null =
      downloaded && mediaRowId
        ? {
            id: mediaRowId,
            tgMessageId: msg.id,
            groupedId: msg.groupedId ? msg.groupedId.toString() : null,
            orderIndex,
            storagePath: downloaded.relPath,
            mediaType: 'image/jpeg',
            bytes: downloaded.buffer.length,
            sha256: downloaded.sha256,
          }
        : null

    const member: AlbumMemberInput = {
      id: messageId,
      channelId: Number(source.channelId),
      tgMessageId: msg.id,
      topicId: source.topicId,
      groupedId: msg.groupedId ? msg.groupedId.toString() : null,
      replyToMsgId: msg.replyTo?.replyToMsgId ?? null,
      replyToTopId: msg.replyTo?.replyToTopId ?? null,
      isTopicMessage: Boolean(msg.replyTo?.forumTopic),
      text,
      // has_media отражает факт наличия СКАЧИВАЕМОГО медиа (pickMedia() нашёл фото или
      // видео-превью), а не успех самого скачивания. Осознанно НЕ downloaded != null:
      // если скачивание уронила сетевая флуктуация/необработанный FloodWait, медиа всё равно
      // объективно существует — has_media=true остаётся честным сигналом и превращает
      // сообщение в кандидата ремонтного прохода (repairMissingMedia). Обратное (has_media
      // = downloaded != null) тихо прятало бы потерю: сообщение с реальным фото навсегда
      // выглядело бы как не имеющее медиа, и чинить было бы нечего — ровно дефект задачи 12b
      // (см. .superpowers/sdd/task-12b-report.md, §"Причина"). Стикеры и видео без PhotoSize
      // (pickMedia() вернул null) законно остаются has_media=false — это не потеря.
      hasMedia: hint != null,
      mediaKind: msg.media?.className ?? null,
      msgTs,
      editedTs,
      raw: snapshotMessage(msg),
      media,
    }

    return {
      source,
      tgMessageId: msg.id,
      text,
      msgTs,
      member,
      mediaEntry: downloaded && mediaRowId ? { url: mediaUrl(mediaRowId), kind: downloaded.kind } : null,
    }
  }

  /** Скачивает медиа-файл и кладёт его на диск. Только сетевой I/O + fs — без обращений к БД,
   *  чтобы сбой скачивания не держал открытую транзакцию и не откатывал вставку сообщения.
   *  Ретраится withDownloadRetry (1с/3с/9с, FloodWaitError — err.seconds+1) — это единственное
   *  место в коде, где реально теряются фотографии (задача 12b), поэтому именно здесь, а не в
   *  общем withFloodRetry (тот ретраит только FloodWaitError для лёгких вызовов). */
  private async downloadMediaFile(
    source: ChannelSource,
    msg: Api.Message,
    hint: DownloadHint,
    orderIndex: number,
  ): Promise<DownloadedMedia | null> {
    const buffer = await withDownloadRetry(`downloadMedia ${source.key}#${msg.id}`, () =>
      this.client.downloadMedia(msg, hint.options),
    )
    if (!buffer || typeof buffer === 'string' || buffer.length === 0) return null

    const relPath = path.posix.join(MEDIA_ROOT_REL, source.key, `${msg.id}_${orderIndex}.jpg`)
    const absPath = path.join(REPO_ROOT, relPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, buffer)

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    return { relPath, buffer, sha256, kind: hint.kind }
  }

  /** Реализация MediaFetcher (media-repair.ts) поверх this.client — единственное место, где
   *  MediaRepairService соприкасается с GramJS. Сам сервис от Telegram не зависит и тестируется
   *  фейком этого интерфейса (test/media-repair.test.ts), без реальной MTProto-сессии. */
  private mediaFetcher(): MediaFetcher {
    return {
      fetchMessages: async (source, tgMessageIds) => {
        const resolvedSource = this.resolved.get(source.channelId.toString())
        const entity = resolvedSource?.entity ?? (await this.resolveEntity(source.channelId))
        // getMessages({ids}) отдаёт ровно один элемент на каждый id, СТРОГО в том же порядке
        // (см. node_modules/telegram/client/messages.js _IDsIter._loadNextChunk — на месте
        // удалённого/недоступного сообщения в буфер пушится undefined, позиция не съезжает).
        const messages = await this.withFloodRetry(`repair getMessages ${source.key}`, () =>
          this.client.getMessages(entity, { ids: [...tgMessageIds] }),
        )
        return tgMessageIds.map((_, i) => messages[i])
      },
      downloadMedia: async (source, msg, hint, orderIndex): Promise<DownloadedMediaResult | null> => {
        const downloaded = await this.downloadMediaFile(source, msg, hint, orderIndex)
        if (!downloaded) return null
        return {
          storagePath: downloaded.relPath,
          bytes: downloaded.buffer.length,
          sha256: downloaded.sha256,
          mediaType: 'image/jpeg',
        }
      },
    }
  }

  private async onDeleted(event: DeletedMessageEvent): Promise<void> {
    const peer = event.peer
    if (!(peer instanceof Api.PeerChannel)) return // приватные чаты вне периметра источников (§7)
    const resolvedSource = this.resolved.get(peer.channelId.toString())
    if (!resolvedSource) return

    const channelId = Number(resolvedSource.source.channelId)
    for (const id of event.deletedIds) {
      await this.db
        .updateTable('messages')
        .set({ deleted: true })
        .where('channel_id', '=', channelId)
        .where('tg_message_id', '=', id)
        .execute()
    }
    console.warn(`[tg-ingest] удаление: канал ${resolvedSource.source.key}, id=[${event.deletedIds.join(',')}]`)
  }

  /** FloodWaitError.seconds ≤ floodSleepThreshold(60) GramJS спит сам; выше — бросает наружу,
   *  и досыпать обязаны мы сами, с джиттером (§5). */
  private async withFloodRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (err instanceof FloodWaitError && attempt <= 3) {
          const jitterMs = Math.floor(Math.random() * 1000)
          console.warn(`[tg-ingest] FloodWait на "${label}": сплю ${err.seconds}с (попытка ${attempt})`)
          await sleep(err.seconds * 1000 + jitterMs)
          continue
        }
        throw err
      }
    }
  }

  private logError(context: string, err: unknown): void {
    // Не глушим молча ничего, кроме benign-TIMEOUT (тот гасится setLogLevel(WARN) на уровне клиента).
    console.error(`[tg-ingest] ${context}:`, err)
  }
}
