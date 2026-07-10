import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

// NUMERIC приходит из pg строкой — оставляем string и парсим Decimal'ом в домене,
// иначе теряем точность на ценах/размерах (Ф0 деньги не использует, но типы объявляем сразу правильно).
export interface DB {
  users: {
    id: string
    username: string
    password_hash: string
    role: string
    created_at: Date
    updated_at: Date
  }
  channels: {
    id: number
    ord: number
    key: string
    source_kind: 'channel' | 'forum_topic'
    topic_id: number | null
    adapter_id: string
    title: string | null
    handle: string | null
    status: 'active' | 'paused' | 'error'
    last_seen_message_id: number
    bybit_sub_uid: number | null
    bybit_api_key_enc: string | null
    bybit_api_secret_enc: string | null
    created_at: Date
    updated_at: Date
  }
  messages: {
    id: string
    channel_id: number
    tg_message_id: number
    topic_id: number | null
    grouped_id: string | null
    reply_to_msg_id: number | null
    reply_to_top_id: number | null
    is_topic_message: boolean
    text: string
    normalized_text: string | null
    has_media: boolean
    media_kind: string | null
    fwd_from: string | null
    views: number | null
    msg_ts: Date
    edit_count: number
    edited_ts: Date | null
    deleted: boolean
    status: string
    status_reason: string | null
    method: string | null
    ai_summary: string | null
    raw: unknown
    correlation_id: string
    received_at: Date
    updated_at: Date
  }
  message_media: {
    id: string
    message_id: string
    tg_message_id: number
    grouped_id: string | null
    order_index: number
    storage_path: string
    media_type: string
    width: number | null
    height: number | null
    bytes: number | null
    sha256: string | null
    created_at: Date
  }
  domain_events: {
    id: number
    type: string
    aggregate: string
    aggregate_id: string | null
    payload: unknown
    created_at: Date
    published_at: Date | null
  }
  // остальные таблицы схемы (channel_settings, processed_messages, parse_results, ai_calls,
  // ai_cache, actions, trades, trade_legs, orders, executions, symbol_ownership, positions,
  // instruments, audit_log, app_state) объявляются здесь же по мере использования в Ф1–Ф4.
  // Пока созданы миграцией, но не типизированы — тесты, которым нужен сырой SQL, используют sql`...`.
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  })
}
