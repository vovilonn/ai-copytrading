import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { channelBySlot, type ChannelSlot, type E2eChannel, type E2eConfig } from './env.js'

/**
 * Постинг в ТЕСТОВЫЕ каналы от лица юзербота (той же сессии TG_SESSION, которой бот их слушает).
 *
 * Почему той же сессией, а не отдельным аккаунтом: аккаунт уже админ в обоих тестовых каналах
 * (`pnpm tg:chats`), права на постинг есть, второй аккаунт/бота заводить не нужно. Сообщение
 * вернётся нам же через NewMessage-хендлер tg-ingest — это ровно то, что e2e и проверяет.
 *
 * ⚠️ КЛЮЧЕВАЯ ДЕТАЛЬ (найдена первым же прогоном): ДВА процесса на ОДНОЙ строке сессии дерутся
 * за обновления. Пока постер подключён, tg-ingest перестаёт получать realtime, его update-loop
 * уходит в цикл реконнектов, и пост доезжает до БД только после рестарта воркера. Поэтому
 * постер работает СВОИМ auth-key (E2E_TG_SESSION, заводится `pnpm e2e session` — тот же
 * аккаунт), а соединение всё равно держится ровно на время операции: короткое окно дешевле
 * любого объяснения, почему «бот не видит сообщение». Счётчик вложенности (`depth`) позволяет
 * обернуть несколько операций в одно соединение (doctor/reset), не открывая его на каждую.
 */
export interface PostSpec {
  text?: string
  /** Путь к картинке (абсолютный или от корня репозитория) — одиночное фото с подписью. */
  photo?: string
  /** Несколько картинок одним альбомом (grouped_id) — подпись уходит первой. */
  album?: string[]
  /** tg_message_id сообщения, на которое отвечаем (ветка reply адаптеров). */
  replyTo?: number
}

export interface PostResult {
  /** id всех отправленных сообщений (у альбома — по одному на файл, по возрастанию). */
  ids: number[]
  /**
   * Якорь: id, по которому e2e ждёт результат. Для альбома это МИНИМАЛЬНЫЙ id группы —
   * tg-ingest пишет строку messages на каждого участника, но событие/узел таймлайна вешает на
   * первого (repository.ts::saveAlbumWithEvent), и подпись Telegram кладёт тоже в первое.
   */
  anchorId: number
}

export class TgPoster {
  private readonly entities = new Map<ChannelSlot, Api.TypeEntityLike>()
  private depth = 0
  private dialogsLoaded = false

  private constructor(
    private readonly client: TelegramClient,
    private readonly config: E2eConfig,
  ) {
    this.sharesWorkerSession = config.telegram.posterSession === null
  }

  /** true — постер работает на ОБЩЕЙ с воркером сессии (E2E_TG_SESSION не задан). */
  readonly sharesWorkerSession: boolean

  static create(config: E2eConfig): TgPoster {
    const client = new TelegramClient(
      new StringSession(config.telegram.posterSession ?? config.telegram.session),
      config.telegram.apiId,
      config.telegram.apiHash,
      { connectionRetries: 5 },
    )
    // Логи GramJS уровня INFO забивают вывод отчёта прогона — оставляем только ошибки.
    client.setLogLevel(LogLevel.ERROR)
    return new TgPoster(client, config)
  }

  /**
   * Выполняет операции в рамках ОДНОГО соединения и гарантированно отключается на выходе.
   * Вложенные вызовы переиспользуют уже открытое соединение (счётчик depth).
   */
  async withConnection<T>(fn: () => Promise<T>): Promise<T> {
    if (this.depth === 0) {
      await this.client.connect()
      if (!(await this.client.isUserAuthorized())) {
        await this.client.disconnect()
        throw new Error('e2e: сессия Telegram не авторизована — выполните `pnpm tg:login`')
      }
      if (!this.dialogsLoaded) {
        // Один проход по диалогам наполняет кеш access_hash сессии: без него getEntity по
        // «голому» id падает (та же причина, что в scripts/lib/tg.mjs). Кеш живёт в объекте
        // сессии и переживает переподключения — грузим ровно один раз за процесс.
        await this.client.getDialogs({ limit: 1000 })
        this.dialogsLoaded = true
      }
    }
    this.depth += 1
    try {
      return await fn()
    } finally {
      this.depth -= 1
      if (this.depth === 0) await this.client.disconnect()
    }
  }

  /** Аккаунт, под которым работает юзербот — его же права проверяет doctor. */
  async me(): Promise<{ name: string; username: string | null; phone: string | null }> {
    return this.withConnection(async () => {
      const user = (await this.client.getMe()) as Api.User
      return {
        name: [user.firstName, user.lastName].filter(Boolean).join(' '),
        username: user.username ?? null,
        phone: user.phone ?? null,
      }
    })
  }

  private async entityOf(slot: ChannelSlot): Promise<Api.TypeEntityLike> {
    const cached = this.entities.get(slot)
    if (cached) return cached
    const channel: E2eChannel = channelBySlot(this.config, slot)
    // id каналов заведомо меньше MAX_SAFE_INTEGER (тот же аргумент, что в ingest.service.ts).
    const entity = await this.client.getEntity(Number(channel.tgId))
    const resolved = Array.isArray(entity) ? entity[0]! : entity
    this.entities.set(slot, resolved)
    return resolved
  }

  /** Название/права канала — для doctor: «мы точно можем сюда писать». */
  async describe(slot: ChannelSlot): Promise<{ title: string; canPost: boolean; kind: string }> {
    return this.withConnection(async () => {
      const entity = (await this.entityOf(slot)) as Api.Channel | Api.Chat
      const isChannel = entity instanceof Api.Channel
      const creator = isChannel && entity.creator === true
      const admin = isChannel && Boolean(entity.adminRights?.postMessages ?? entity.adminRights)
      return {
        title: 'title' in entity ? entity.title : '(без названия)',
        // Для broadcast-канала право писать даёт creator/adminRights.postMessages; в обычной
        // группе (не broadcast) писать может любой участник.
        canPost: isChannel ? (entity.broadcast === true ? creator || admin : true) : true,
        kind: isChannel ? (entity.broadcast ? 'канал' : entity.forum ? 'форум' : 'группа') : 'группа',
      }
    })
  }

  /** Последний id сообщения в канале — точка, с которой e2e начинает «новую жизнь» курсора. */
  async lastMessageId(slot: ChannelSlot): Promise<number> {
    return this.withConnection(async () => {
      const entity = await this.entityOf(slot)
      const channel = channelBySlot(this.config, slot)
      const messages = await this.client.getMessages(entity, {
        limit: 1,
        ...(channel.topicId != null ? { replyTo: channel.topicId } : {}),
      })
      return messages[0]?.id ?? 0
    })
  }

  async post(slot: ChannelSlot, spec: PostSpec): Promise<PostResult> {
    return this.withConnection(async () => {
      const entity = await this.entityOf(slot)
      const channel = channelBySlot(this.config, slot)
      // Источник — форум-топик: пост обязан лечь В ТОТ ЖЕ топик, иначе topic-filter.ts его
      // отсеет (`topicOf(...) === 'other'`) и сообщение не дойдёт до пайплайна вовсе.
      const topic = channel.topicId != null ? { topMsgId: channel.topicId } : {}
      const replyTo = spec.replyTo !== undefined ? { replyTo: spec.replyTo } : {}

      if (spec.album && spec.album.length > 0) {
        const sent = await this.client.sendFile(entity, {
          file: spec.album,
          ...(spec.text !== undefined ? { caption: spec.text } : {}),
          ...replyTo,
          ...topic,
        })
        // ВНИМАНИЕ на типы GramJS: sendFile объявлен как Promise<Api.Message>, но для АЛЬБОМА
        // (_sendAlbum → _getResponseMessage со списком randomId) реально возвращает МАССИВ
        // сообщений. Без этой ветки `sent.id` был undefined, и якорь превращался в NaN —
        // поймано прогоном (шаг «Альбом из двух графиков» падал на запросе к БД).
        const messages = (Array.isArray(sent) ? sent : [sent]) as Api.Message[]
        const ids = messages.map((m) => m.id).filter((id): id is number => Number.isFinite(id))
        if (ids.length === 0) throw new Error('e2e: Telegram не вернул id ни одного сообщения альбома')
        // Подстраховка: если участников вернулось меньше, чем файлов, добираем по общему
        // grouped_id — именно их набор и увидит tg-ingest (album-buffer.ts).
        const full = ids.length >= spec.album.length ? ids : await this.albumIds(slot, messages[0]!)
        return { ids: full.sort((a, b) => a - b), anchorId: Math.min(...full) }
      }

      if (spec.photo) {
        const sent = await this.client.sendFile(entity, {
          file: spec.photo,
          ...(spec.text !== undefined ? { caption: spec.text } : {}),
          ...replyTo,
          ...topic,
        })
        return { ids: [sent.id], anchorId: sent.id }
      }

      if (spec.text === undefined || spec.text.length === 0) {
        throw new Error('e2e: пустой пост — нужен text, photo или album')
      }
      const sent = await this.client.sendMessage(entity, { message: spec.text, ...replyTo, ...topic })
      return { ids: [sent.id], anchorId: sent.id }
    })
  }

  /** Правка ранее отправленного сообщения — путь EditedMessage в tg-ingest (edit_count++). */
  async edit(slot: ChannelSlot, messageId: number, text: string): Promise<number> {
    return this.withConnection(async () => {
      const entity = await this.entityOf(slot)
      const edited = await this.client.editMessage(entity, { message: messageId, text })
      return edited.id
    })
  }

  /** Удаление — путь DeletedMessage (messages.deleted=true). */
  async delete(slot: ChannelSlot, messageIds: number[]): Promise<void> {
    await this.withConnection(async () => {
      const entity = await this.entityOf(slot)
      await this.client.deleteMessages(entity, messageIds, { revoke: true })
    })
  }

  private async albumIds(slot: ChannelSlot, sent: Api.Message): Promise<number[]> {
    if (!sent.groupedId) return [sent.id]
    const entity = await this.entityOf(slot)
    const grouped = sent.groupedId.toString()
    // Читаем небольшой хвост канала: участники альбома идут подряд, но id ведущего может быть
    // как первым, так и последним — фильтр по grouped_id надёжнее арифметики по id.
    const tail = await this.client.getMessages(entity, { limit: 20 })
    const ids = tail.filter((m) => m.groupedId?.toString() === grouped).map((m) => m.id)
    return ids.length > 0 ? ids.sort((a, b) => a - b) : [sent.id]
  }

  /** Полное закрытие клиента (в отличие от disconnect — объект больше не переиспользуется). */
  async close(): Promise<void> {
    if (this.depth > 0) await this.client.disconnect()
    await this.client.destroy()
  }
}
