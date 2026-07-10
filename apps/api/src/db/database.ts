import { Kysely, PostgresDialect, type Generated } from 'kysely'
import pg from 'pg'

// node-postgres по умолчанию отдаёт int8 строкой, чтобы не потерять точность.
// Все наши BIGINT (id каналов и сообщений Telegram, счётчик событий) заведомо
// меньше Number.MAX_SAFE_INTEGER, поэтому читаем их числом — иначе типы DB лгут,
// и сравнения вида channel.id === 123 молча ломаются.
// Регистрируется один раз на уровне модуля (до создания пула), т.к. парсер типов
// глобален для процесса — pg.types общий для всех pg.Pool в рамках модуля 'pg'.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value))

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
    // Generated<T> — колонки с DEFAULT в схеме (001_initial.ts): при select приходят T,
    // при insertInto(...).values(...) необязательны — иначе Kysely требует передавать их вручную
    // и дублировать значение DEFAULT из миграции (впервые всплыло в repository.ts, задача 5).
    id: Generated<string>
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
    edit_count: Generated<number>
    edited_ts: Date | null
    deleted: Generated<boolean>
    status: Generated<string>
    status_reason: string | null
    method: string | null
    ai_summary: string | null
    raw: unknown
    correlation_id: Generated<string>
    received_at: Generated<Date>
    updated_at: Generated<Date>
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
    // id (BIGSERIAL) и created_at (DEFAULT now()) — задача 9 впервые вставляет строки в эту
    // таблицу, поэтому оборачиваем в Generated<>, как и другие DEFAULT-колонки (messages выше):
    // иначе insertInto(...).values() требовал бы указывать nextval-значение id вручную.
    id: Generated<number>
    type: string
    aggregate: string
    aggregate_id: string | null
    payload: unknown
    created_at: Generated<Date>
    published_at: Date | null
  }
  channel_settings: {
    channel_id: number
    enabled: boolean
    // денежные/числовые NUMERIC-колонки — string (см. комментарий выше про точность)
    trade_size: string
    max_leverage: string
    default_leverage: string | null
    cross_margin: boolean
    no_sl_policy: string
    no_sl_buffer_sec: number
    add_sizing_mode: string
    max_symbol_notional: string | null
    mirror_manual_fraction: boolean
    limit_ttl_sec: number
    updated_at: Date
  }
  // остальные таблицы схемы (processed_messages, parse_results, ai_calls,
  // ai_cache, actions, trades, trade_legs, orders, executions, symbol_ownership, positions,
  // instruments, audit_log, app_state) объявляются здесь же по мере использования в Ф1–Ф4.
  // Пока созданы миграцией, но не типизированы — тесты, которым нужен сырой SQL, используют sql`...`.
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  })
}
