import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { DatabaseService } from '../db/database.service.js'

/**
 * Дублирует apps/tg-ingest/src/sources.ts (id/key/topicId/adapterId) — оба сервиса сидируют
 * одни и те же 2 канала независимо друг от друга: api не имеет доступа к Telegram, чтобы
 * динамически резолвить title/handle, поэтому свой сид оставляет их null. ON CONFLICT(id) DO
 * NOTHING никогда не перезаписывает title/handle/ord, выставленные при первом реальном
 * коннекте tg-ingest, — порядок запуска сервисов не важен.
 */
const CHANNEL_SEEDS = [
  { id: 2088626562, key: 'ch-2088626562', topicId: null, adapterId: 'ch1-structured' },
  { id: 1962583820, key: 'ch-1962583820-t173666', topicId: 173666, adapterId: 'ch2-freeform' },
] as const

@Injectable()
export class ChannelSeedService implements OnModuleInit {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    let ord = 1
    for (const seed of CHANNEL_SEEDS) {
      await this.seedOne(seed, ord)
      ord += 1
    }
  }

  private async seedOne(seed: (typeof CHANNEL_SEEDS)[number], ord: number): Promise<void> {
    const now = new Date()
    const db = this.database.db

    await db
      .insertInto('channels')
      .values({
        id: seed.id,
        ord,
        key: seed.key,
        source_kind: seed.topicId != null ? 'forum_topic' : 'channel',
        topic_id: seed.topicId,
        adapter_id: seed.adapterId,
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
        channel_id: seed.id,
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
