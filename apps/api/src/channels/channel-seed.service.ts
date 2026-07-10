import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { CHANNEL_SOURCES, type ChannelSource } from 'shared/sources.js'
import { DatabaseService } from '../db/database.service.js'

/**
 * Список каналов — единый источник CHANNEL_SOURCES (packages/shared/src/sources.ts), общий с
 * apps/tg-ingest/src/ingest.service.ts. Оба сервиса сидируют одни и те же каналы независимо
 * друг от друга: api не имеет доступа к Telegram, чтобы динамически резолвить title/handle,
 * поэтому свой сид оставляет их null. ON CONFLICT(id) DO NOTHING никогда не перезаписывает
 * title/handle/ord, выставленные при первом реальном коннекте tg-ingest, — порядок запуска
 * сервисов не важен.
 */
@Injectable()
export class ChannelSeedService implements OnModuleInit {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    for (const source of CHANNEL_SOURCES) {
      await this.seedOne(source)
    }
  }

  private async seedOne(source: ChannelSource): Promise<void> {
    const now = new Date()
    const db = this.database.db
    const channelId = Number(source.channelId) // channels.id в БД — BIGINT, читается Kysely как number

    await db
      .insertInto('channels')
      .values({
        id: channelId,
        ord: source.ord,
        key: source.key,
        source_kind: source.sourceKind,
        topic_id: source.topicId,
        adapter_id: source.adapterId,
        title: null,
        handle: null,
        status: 'active',
        last_seen_message_id: 0,
        bybit_sub_uid: null,
        bybit_api_key_enc: null,
        bybit_api_secret_enc: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()

    await db
      .insertInto('channel_settings')
      .values({
        channel_id: channelId,
        enabled: false,
        trade_size: '500',
        max_leverage: '10',
        default_leverage: null,
        cross_margin: true,
        no_sl_policy: 'attach_protective_sl',
        no_sl_buffer_sec: 0,
        add_sizing_mode: 'trade_size',
        max_symbol_notional: null,
        mirror_manual_fraction: false,
        limit_ttl_sec: 604_800,
        updated_at: now,
      })
      // Не затираем настройки, выставленные оператором из админки после старта.
      .onConflict((oc) => oc.column('channel_id').doNothing())
      .execute()
  }
}
