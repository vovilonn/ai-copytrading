import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import pg from 'pg'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/config.schema.js'
import { DatabaseService } from '../db/database.service.js'
import type { ServerToClientEvents } from 'shared/ws-events.js'
import { RealtimeGateway } from './realtime.gateway.js'

const BATCH_SIZE = 100
const POLL_INTERVAL_MS = 5000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const NOTIFY_CHANNEL = 'domain_events'

/**
 * Outbox-паттерн задачи 9: слушает `LISTEN domain_events` через отдельное (не из пула)
 * pg-подключение и рассылает неопубликованные строки в комнаты socket.io. Переживает рестарт
 * api — на старте и после каждого реконнекта сначала догоняет накопленное (SELECT ... WHERE
 * published_at IS NULL), а не полагается только на сами уведомления. Периодический опрос —
 * страховка на случай, если NOTIFY потерялся (например, окно между обрывом и реконнектом).
 */
@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name)
  private listenClient: pg.Client | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelayMs = RECONNECT_BASE_MS
  private stopped = false
  // Не даёт NOTIFY-обработчику и периодическому опросу перекрыться одним и тем же батчем.
  private draining = false

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RealtimeGateway) private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connectListener()
    this.pollTimer = setInterval(() => {
      this.drainUnpublished().catch((err) => this.logger.error(`периодический опрос outbox: ${String(err)}`))
    }, POLL_INTERVAL_MS)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.listenClient) {
      const client = this.listenClient
      this.listenClient = null
      client.removeAllListeners()
      await client.end().catch(() => {
        // Пул уже мог быть закрыт (app.close() гасит DatabaseService раньше/позже) — не критично.
      })
    }
  }

  private async connectListener(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.databaseUrl })

    client.on('error', (err) => {
      this.logger.warn(`соединение LISTEN оборвалось: ${err.message}`)
      this.scheduleReconnect()
    })
    client.on('notification', (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL) return
      this.drainUnpublished().catch((err) => this.logger.error(`обработка NOTIFY: ${String(err)}`))
    })

    await client.connect()
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`)
    this.listenClient = client
    this.reconnectDelayMs = RECONNECT_BASE_MS
    this.logger.log(`LISTEN ${NOTIFY_CHANNEL} активен`)

    // На старте и после реконнекта могло накопиться неопубликованное — тот же путь, что и NOTIFY.
    await this.drainUnpublished()
  }

  /** Планирует переподключение с экспоненциальным backoff (капped RECONNECT_MAX_MS). */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return

    if (this.listenClient) {
      const client = this.listenClient
      this.listenClient = null
      client.removeAllListeners()
      client.end().catch(() => {})
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectListener().catch((err) => {
        this.logger.error(`реконнект LISTEN не удался: ${String(err)}`)
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS)
        this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
  }

  /** Читает и рассылает неопубликованные события батчами по BATCH_SIZE, пока не останется ни
   *  одного — так одно скопившееся событие не тормозит следующие до следующего тика опроса. */
  private async drainUnpublished(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      let batchSize = 0
      do {
        // FOR UPDATE SKIP LOCKED + выборка и UPDATE published_at в одной транзакции: `draining`
        // защищает только от гонки внутри одного процесса api, а при двух репликах api независимый
        // `draining` каждой не спасает — обе выберут одни и те же строки с published_at IS NULL и
        // разошлют дубли клиентам. SKIP LOCKED отдаёт реплике только строки, не залоченные другой
        // (та просто пропускает их и заберёт следующим тиком), а транзакция гарантирует, что между
        // SELECT ... FOR UPDATE и UPDATE published_at строку не перехватит третий конкурент.
        batchSize = await this.database.db.transaction().execute(async (trx) => {
          const rows = await trx
            .selectFrom('domain_events')
            .selectAll()
            .where('published_at', 'is', null)
            .orderBy('id', 'asc')
            .limit(BATCH_SIZE)
            .forUpdate()
            .skipLocked()
            .execute()
          if (rows.length === 0) return 0

          // Рассылаем до коммита UPDATE published_at — так же, как раньше вне транзакции (см.
          // комментарий про outbox-инвариант в realtime.e2e.test.ts, task-9-brief §3): при крэше
          // между emit и коммитом клиент в худшем случае получит дубль на следующем тике опроса,
          // а не потеряет событие навсегда, если бы published_at успел закоммититься раньше рассылки.
          for (const row of rows) this.publishRow(row)

          await trx
            .updateTable('domain_events')
            .set({ published_at: new Date() })
            .where(
              'id',
              'in',
              rows.map((r) => r.id),
            )
            .execute()

          return rows.length
        })
      } while (batchSize === BATCH_SIZE)
    } finally {
      this.draining = false
    }
  }

  private publishRow(row: { type: string; payload: unknown }): void {
    // payload всегда объект с channelId — контракт задачи 9 (MessageNewPayload/ChannelStatsPayload,
    // см. packages/shared/src/ws-events.ts). Строка без channelId — испорченные данные продюсера,
    // а не повод остановить рассылку остального батча.
    const payload = row.payload as { channelId?: unknown } | null
    if (!payload || typeof payload.channelId !== 'number') {
      this.logger.warn(`событие "${row.type}" без числового channelId в payload — пропускаю рассылку`)
      return
    }
    this.gateway.emitToChannel(payload.channelId, row.type as keyof ServerToClientEvents, payload)
  }
}
