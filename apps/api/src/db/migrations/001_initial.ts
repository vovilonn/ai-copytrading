import { Kysely, sql } from 'kysely'

// Полная схема из docs/superpowers/research/backend-architecture.md §2, перенесённая как есть,
// с правками под решение «субаккаунт Bybit на канал» (см. .superpowers/sdd/task-2-brief.md).
//
// Каждое CREATE/ALTER выполняется отдельным execute(): pg под node-postgres шлёт sql-тег
// как parameterized-запрос (extended protocol), а Postgres не позволяет несколько команд
// в одном prepared statement — поэтому склеивать все statements в один `sql`...`` нельзя.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function up(db: Kysely<any>): Promise<void> {
  // ============ РАСШИРЕНИЯ / ENUM'ы / SEQUENCES ============
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db) // gen_random_uuid()

  await sql`CREATE TYPE source_kind AS ENUM ('channel','forum_topic')`.execute(db)
  await sql`CREATE TYPE channel_status AS ENUM ('active','paused','error')`.execute(db)
  await sql`CREATE TYPE msg_status AS ENUM ('received','normalized','parsed','decided',
                                             'executing','executed','skipped','needs_review','noise','failed')`.execute(
    db,
  )
  await sql`CREATE TYPE parser_kind AS ENUM ('deterministic','ai')`.execute(db)
  await sql`CREATE TYPE parse_route AS ENUM ('execute','ai','skip','noise')`.execute(db)
  await sql`CREATE TYPE parse_method AS ENUM ('auto','ai','review')`.execute(db) // UI Method
  await sql`CREATE TYPE action_type AS ENUM ('open','add','close','partial_tp','partial_close',
                                              'modify_sl','modify_tp','cancel_order','tp_hit','sl_hit','close_all','hold')`.execute(
    db,
  )
  await sql`CREATE TYPE side_t AS ENUM ('long','short')`.execute(db)
  await sql`CREATE TYPE action_status AS ENUM ('pending','executing','executed','skipped','needs_review','failed')`.execute(
    db,
  )
  await sql`CREATE TYPE trade_status AS ENUM ('pending','open','partially_closed','closed','cancelled','skipped')`.execute(
    db,
  )
  await sql`CREATE TYPE leg_kind AS ENUM ('entry','add')`.execute(db)
  await sql`CREATE TYPE leg_status AS ENUM ('pending','working','partially_filled','filled','cancelled','rejected')`.execute(
    db,
  )
  await sql`CREATE TYPE order_purpose AS ENUM ('entry','add','tp','sl','close','cancel')`.execute(db)
  await sql`CREATE TYPE order_type_t AS ENUM ('market','limit')`.execute(db)
  await sql`CREATE TYPE order_status AS ENUM ('created','pending_submit','submitted','partially_filled',
                                               'filled','rejected','cancelled','expired')`.execute(db)
  await sql`CREATE TYPE exec_mode AS ENUM ('dry_run','live')`.execute(db)
  await sql`CREATE TYPE net_t AS ENUM ('testnet','mainnet')`.execute(db)

  await sql`CREATE SEQUENCE trade_ref_seq START 1042`.execute(db) // TR-1042 первый; человекочитаемый id сделки

  // ============ AUTH ============
  await sql`
    CREATE TABLE users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // ============ КАНАЛЫ ============
  // + bybit_sub_uid/bybit_api_key_enc/bybit_api_secret_enc: субаккаунт Bybit на канал (решение заказчика).
  await sql`
    CREATE TABLE channels (
      id                    BIGINT PRIMARY KEY,
      ord                   SMALLINT NOT NULL UNIQUE,
      key                   TEXT NOT NULL UNIQUE,
      source_kind           source_kind NOT NULL,
      topic_id              INT,
      adapter_id            TEXT NOT NULL,
      title                 TEXT,
      handle                TEXT,
      status                channel_status NOT NULL DEFAULT 'active',
      last_seen_message_id  BIGINT NOT NULL DEFAULT 0,
      bybit_sub_uid         BIGINT,
      bybit_api_key_enc     TEXT,
      bybit_api_secret_enc  TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // channel_settings: equity_share_pct заменён на cross_margin (у канала свой субаккаунт —
  // режим маржи реален, не логический лимит), no_sl_policy дефолтится в attach_protective_sl.
  await sql`
    CREATE TABLE channel_settings (
      channel_id            BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
      enabled               BOOLEAN  NOT NULL DEFAULT false,
      trade_size            NUMERIC(20,8) NOT NULL,
      max_leverage          NUMERIC(6,2)  NOT NULL,
      default_leverage      NUMERIC(6,2),
      cross_margin          BOOLEAN NOT NULL DEFAULT true,
      no_sl_policy          TEXT NOT NULL DEFAULT 'attach_protective_sl'
                            CHECK (no_sl_policy IN ('skip','attach_protective_sl','attach_from_next','buffer','default_sl')),
      no_sl_buffer_sec      INT NOT NULL DEFAULT 0,
      add_sizing_mode       TEXT NOT NULL DEFAULT 'trade_size'
                            CHECK (add_sizing_mode IN ('trade_size','risk','orig_fraction')),
      max_symbol_notional   NUMERIC(20,8),
      mirror_manual_fraction BOOLEAN NOT NULL DEFAULT false,
      limit_ttl_sec         INT NOT NULL DEFAULT 604800,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // ============ СООБЩЕНИЯ ============
  // + reply_to_top_id/is_topic_message/ai_summary — поля, вскрытые верификацией (см. брифа п.3).
  await sql`
    CREATE TABLE messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id      BIGINT NOT NULL REFERENCES channels(id),
      tg_message_id   BIGINT NOT NULL,
      topic_id        INT,
      grouped_id      TEXT,
      reply_to_msg_id BIGINT,
      reply_to_top_id BIGINT,
      is_topic_message BOOLEAN NOT NULL DEFAULT false,
      text            TEXT NOT NULL DEFAULT '',
      normalized_text TEXT,
      has_media       BOOLEAN NOT NULL DEFAULT false,
      media_kind      TEXT,
      fwd_from        TEXT,
      views           INT,
      msg_ts          TIMESTAMPTZ NOT NULL,
      edit_count      INT NOT NULL DEFAULT 0,
      edited_ts       TIMESTAMPTZ,
      deleted         BOOLEAN NOT NULL DEFAULT false,
      status          msg_status NOT NULL DEFAULT 'received',
      status_reason   TEXT,
      method          parse_method,
      ai_summary      TEXT,
      raw             JSONB NOT NULL,
      correlation_id  UUID NOT NULL DEFAULT gen_random_uuid(),
      received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (channel_id, tg_message_id)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_msg_channel_status ON messages (channel_id, status)`.execute(db)
  await sql`CREATE INDEX idx_msg_channel_tgid ON messages (channel_id, tg_message_id)`.execute(db)
  await sql`CREATE INDEX idx_msg_grouped ON messages (grouped_id) WHERE grouped_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX idx_msg_ts ON messages (msg_ts)`.execute(db)
  await sql`
    CREATE INDEX idx_msg_pipeline ON messages (channel_id, tg_message_id)
      WHERE status IN ('received','normalized','parsed','decided','executing')
  `.execute(db)

  await sql`
    CREATE TABLE message_media (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      tg_message_id BIGINT NOT NULL,
      grouped_id    TEXT,
      order_index   INT NOT NULL DEFAULT 0,
      storage_path  TEXT NOT NULL,
      media_type    TEXT NOT NULL DEFAULT 'image/jpeg',
      width         INT, height INT, bytes INT,
      sha256        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX idx_media_message ON message_media (message_id)`.execute(db)

  await sql`
    CREATE TABLE processed_messages (
      channel_id   BIGINT NOT NULL,
      message_id   BIGINT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (channel_id, message_id)
    )
  `.execute(db)

  // ============ РАЗБОР ============
  await sql`
    CREATE TABLE parse_results (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      parser        parser_kind NOT NULL,
      adapter_id    TEXT,
      route         parse_route NOT NULL,
      confidence    NUMERIC(4,3) NOT NULL,
      intents       JSONB NOT NULL,
      reason        TEXT,
      needs_vision  BOOLEAN NOT NULL DEFAULT false,
      prompt_version TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX idx_parse_message ON parse_results (message_id)`.execute(db)

  await sql`
    CREATE TABLE ai_calls (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
      parse_result_id UUID REFERENCES parse_results(id) ON DELETE SET NULL,
      model         TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      request_hash  TEXT NOT NULL,
      input_tokens              INT NOT NULL DEFAULT 0,
      cache_creation_input_tokens INT NOT NULL DEFAULT 0,
      cache_read_input_tokens     INT NOT NULL DEFAULT 0,
      output_tokens             INT NOT NULL DEFAULT 0,
      cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
      latency_ms    INT NOT NULL,
      http_status   INT,
      attempt       INT NOT NULL DEFAULT 1,
      cache_hit     BOOLEAN NOT NULL DEFAULT false,
      escalated     BOOLEAN NOT NULL DEFAULT false,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX idx_ai_message ON ai_calls (message_id)`.execute(db)
  await sql`CREATE INDEX idx_ai_model_time ON ai_calls (model, created_at)`.execute(db)
  await sql`CREATE INDEX idx_ai_reqhash ON ai_calls (request_hash)`.execute(db)

  await sql`
    CREATE TABLE ai_cache (
      request_hash  TEXT PRIMARY KEY,
      model         TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      response      JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)

  // ============ ДЕЙСТВИЯ (плоский слой для Actions-таблицы и timeline) ============
  // trade_id — БЕЗ FK здесь: trades ещё не существует (forward reference в исходном DDL).
  // FK добавляется ALTER'ом сразу после CREATE TABLE trades ниже.
  await sql`
    CREATE TABLE actions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id    BIGINT NOT NULL REFERENCES channels(id),
      action_index  INT NOT NULL,
      type          action_type NOT NULL,
      side          side_t,
      symbol        TEXT,
      pair          TEXT,
      method        parse_method NOT NULL,
      trade_id      UUID,
      pct           NUMERIC(6,3),
      params        JSONB NOT NULL DEFAULT '{}',
      detail        TEXT,
      status        action_status NOT NULL DEFAULT 'pending',
      skip_reason   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      executed_at   TIMESTAMPTZ,
      UNIQUE (message_id, action_index)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_action_channel_time ON actions (channel_id, created_at DESC)`.execute(db)
  await sql`CREATE INDEX idx_action_trade ON actions (trade_id)`.execute(db)
  await sql`CREATE INDEX idx_action_symbol ON actions (symbol)`.execute(db)
  await sql`CREATE INDEX idx_action_type ON actions (type)`.execute(db)
  await sql`CREATE INDEX idx_action_status ON actions (status)`.execute(db)

  // ============ СДЕЛКИ / ЛЕГИ ============
  await sql`
    CREATE TABLE trades (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      human_ref     TEXT NOT NULL UNIQUE,
      seq           BIGINT NOT NULL UNIQUE,
      channel_id    BIGINT NOT NULL REFERENCES channels(id),
      symbol        TEXT NOT NULL,
      side          side_t NOT NULL,
      status        trade_status NOT NULL DEFAULT 'pending',
      opened_action_id UUID REFERENCES actions(id),
      opened_msg_id UUID REFERENCES messages(id),
      avg_entry     NUMERIC(30,10),
      size          NUMERIC(30,10) NOT NULL DEFAULT 0,
      initial_size  NUMERIC(30,10),
      leverage      NUMERIC(6,2),
      margin_mode   TEXT NOT NULL DEFAULT 'cross',
      realized_pnl  NUMERIC(30,10) NOT NULL DEFAULT 0,
      fees_paid     NUMERIC(30,10) NOT NULL DEFAULT 0,
      is_win        BOOLEAN,
      opened_at     TIMESTAMPTZ,
      closed_at     TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX idx_trade_channel_status ON trades (channel_id, status)`.execute(db)
  await sql`CREATE INDEX idx_trade_symbol_status ON trades (symbol, status)`.execute(db)
  await sql`
    CREATE INDEX idx_trade_history ON trades (channel_id, closed_at DESC) WHERE status IN ('closed','cancelled')
  `.execute(db)

  // forward-reference fix: actions.trade_id → trades.id (trades только что создан)
  await sql`
    ALTER TABLE actions ADD CONSTRAINT actions_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id)
  `.execute(db)

  // Модель "объём/лега" (B6): один добор = одна лега; "один объём" = qty одной леги
  await sql`
    CREATE TABLE trade_legs (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_id          UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
      leg_index         INT NOT NULL,
      kind              leg_kind NOT NULL,
      source_message_id UUID REFERENCES messages(id),
      source_action_id  UUID REFERENCES actions(id),
      requested_qty     NUMERIC(30,10) NOT NULL,
      filled_qty        NUMERIC(30,10) NOT NULL DEFAULT 0,
      avg_price         NUMERIC(30,10),
      notional          NUMERIC(30,10),
      status            leg_status NOT NULL DEFAULT 'pending',
      opened_at         TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (trade_id, leg_index)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_leg_trade ON trade_legs (trade_id)`.execute(db)

  // ============ ОРДЕРА (транзакционный OUTBOX) ============
  await sql`
    CREATE TABLE orders (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_id      UUID REFERENCES trades(id),
      leg_id        UUID REFERENCES trade_legs(id),
      action_id     UUID NOT NULL REFERENCES actions(id),
      channel_id    BIGINT NOT NULL REFERENCES channels(id),
      symbol        TEXT NOT NULL,
      order_link_id TEXT NOT NULL UNIQUE,
      bybit_order_id TEXT,
      purpose       order_purpose NOT NULL,
      side          side_t NOT NULL,
      order_type    order_type_t NOT NULL,
      reduce_only   BOOLEAN NOT NULL DEFAULT false,
      qty           NUMERIC(30,10),
      price         NUMERIC(30,10),
      trigger_price NUMERIC(30,10),
      tp_index      INT,
      time_in_force TEXT NOT NULL DEFAULT 'GTC',
      status        order_status NOT NULL DEFAULT 'created',
      ret_code      INT,
      ret_msg       TEXT,
      ttl_expires_at TIMESTAMPTZ,
      submit_attempts INT NOT NULL DEFAULT 0,
      submitted_at  TIMESTAMPTZ,
      filled_at     TIMESTAMPTZ,
      cancelled_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE INDEX idx_order_dispatch ON orders (created_at) WHERE status IN ('created','pending_submit')
  `.execute(db)
  await sql`CREATE INDEX idx_order_bybitid ON orders (bybit_order_id) WHERE bybit_order_id IS NOT NULL`.execute(db)
  await sql`CREATE INDEX idx_order_trade ON orders (trade_id)`.execute(db)
  await sql`
    CREATE INDEX idx_order_open_sym ON orders (symbol, reduce_only)
      WHERE status IN ('submitted','partially_filled')
  `.execute(db)
  await sql`
    CREATE INDEX idx_order_ttl ON orders (ttl_expires_at) WHERE status IN ('submitted') AND ttl_expires_at IS NOT NULL
  `.execute(db)

  await sql`
    CREATE TABLE executions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id      UUID REFERENCES orders(id),
      trade_id      UUID REFERENCES trades(id),
      leg_id        UUID REFERENCES trade_legs(id),
      bybit_exec_id TEXT NOT NULL UNIQUE,
      order_link_id TEXT,
      symbol        TEXT NOT NULL,
      side          side_t NOT NULL,
      exec_qty      NUMERIC(30,10) NOT NULL,
      exec_price    NUMERIC(30,10) NOT NULL,
      closed_size   NUMERIC(30,10) NOT NULL DEFAULT 0,
      leaves_qty    NUMERIC(30,10) NOT NULL DEFAULT 0,
      exec_fee      NUMERIC(30,10) NOT NULL DEFAULT 0,
      exec_pnl      NUMERIC(30,10) NOT NULL DEFAULT 0,
      exec_type     TEXT,
      is_maker      BOOLEAN,
      exec_ts       TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX idx_exec_trade ON executions (trade_id)`.execute(db)
  await sql`CREATE INDEX idx_exec_order ON executions (order_id)`.execute(db)

  // ============ ВЛАДЕНИЕ СИМВОЛОМ (решение #1, атомарный захват) ============
  // Уникальность — по (channel_id, symbol), а не по symbol: у канала свой субаккаунт,
  // поэтому два канала могут одновременно владеть одним и тем же символом.
  await sql`
    CREATE TABLE symbol_ownership (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol      TEXT NOT NULL,
      channel_id  BIGINT NOT NULL REFERENCES channels(id),
      trade_id    UUID NOT NULL REFERENCES trades(id),
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      released_at TIMESTAMPTZ
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_symbol_active_per_channel
      ON symbol_ownership (channel_id, symbol) WHERE released_at IS NULL
  `.execute(db)

  // ============ ЗЕРКАЛО ПОЗИЦИЙ (реконсиляция + realtime + Active Positions) ============
  // Композитный PK (channel_id, symbol): у каждого канала свой субаккаунт ⇒ своя позиция по символу.
  await sql`
    CREATE TABLE positions (
      channel_id      BIGINT NOT NULL REFERENCES channels(id),
      symbol          TEXT NOT NULL,
      trade_id        UUID REFERENCES trades(id),
      side            side_t,
      size            NUMERIC(30,10) NOT NULL DEFAULT 0,
      avg_price       NUMERIC(30,10),
      mark_price      NUMERIC(30,10),
      liq_price       NUMERIC(30,10),
      leverage        NUMERIC(6,2),
      position_im     NUMERIC(30,10),
      unrealised_pnl  NUMERIC(30,10),
      cur_realised_pnl NUMERIC(30,10),
      take_profit     NUMERIC(30,10),
      stop_loss       NUMERIC(30,10),
      position_status TEXT,
      bybit_seq       BIGINT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (channel_id, symbol)
    )
  `.execute(db)
  await sql`CREATE INDEX idx_pos_channel ON positions (channel_id) WHERE size <> 0`.execute(db)

  // ============ РЕЕСТР ИНСТРУМЕНТОВ (кэш instruments-info, гейт status='Trading') ============
  await sql`
    CREATE TABLE instruments (
      symbol        TEXT NOT NULL,
      network       net_t NOT NULL,
      base_coin     TEXT NOT NULL,
      status        TEXT NOT NULL,
      qty_step      NUMERIC(30,10) NOT NULL,
      min_qty       NUMERIC(30,10) NOT NULL,
      tick_size     NUMERIC(30,10) NOT NULL,
      min_notional  NUMERIC(20,8)  NOT NULL DEFAULT 5,
      max_leverage  NUMERIC(6,2)   NOT NULL,
      leverage_step NUMERIC(6,2)   NOT NULL DEFAULT 0.01,
      refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, network)
    )
  `.execute(db)

  // ============ REALTIME / АУДИТ ============
  await sql`
    CREATE TABLE domain_events (
      id           BIGSERIAL PRIMARY KEY,
      type         TEXT NOT NULL,
      aggregate    TEXT NOT NULL,
      aggregate_id TEXT,
      payload      JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    )
  `.execute(db)
  await sql`CREATE INDEX idx_events_unpub ON domain_events (id) WHERE published_at IS NULL`.execute(db)

  await sql`
    CREATE TABLE audit_log (
      id             BIGSERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor          TEXT NOT NULL,
      action         TEXT NOT NULL,
      entity_type    TEXT,
      entity_id      TEXT,
      correlation_id UUID,
      channel_id     BIGINT,
      before         JSONB,
      after          JSONB,
      meta           JSONB,
      message        TEXT
    )
  `.execute(db)
  await sql`CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id)`.execute(db)
  await sql`CREATE INDEX idx_audit_corr ON audit_log (correlation_id)`.execute(db)
  await sql`CREATE INDEX idx_audit_ts ON audit_log (ts DESC)`.execute(db)

  // Глобальное состояние (execution mode при live-переключении, курсоры реконсиляции)
  await sql`
    CREATE TABLE app_state (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- сигнатура Kysely.Migration требует Kysely<any>
export async function down(db: Kysely<any>): Promise<void> {
  // Обратный откат для Ф0: полностью сносим схему в порядке, обратном созданию FK-зависимостей.
  await sql`DROP TABLE IF EXISTS app_state`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_log`.execute(db)
  await sql`DROP TABLE IF EXISTS domain_events`.execute(db)
  await sql`DROP TABLE IF EXISTS instruments`.execute(db)
  await sql`DROP TABLE IF EXISTS positions`.execute(db)
  await sql`DROP TABLE IF EXISTS symbol_ownership`.execute(db)
  await sql`DROP TABLE IF EXISTS executions`.execute(db)
  await sql`DROP TABLE IF EXISTS orders`.execute(db)
  await sql`DROP TABLE IF EXISTS trade_legs`.execute(db)
  await sql`ALTER TABLE IF EXISTS actions DROP CONSTRAINT IF EXISTS actions_trade_id_fkey`.execute(db)
  await sql`DROP TABLE IF EXISTS trades`.execute(db)
  await sql`DROP TABLE IF EXISTS actions`.execute(db)
  await sql`DROP TABLE IF EXISTS ai_cache`.execute(db)
  await sql`DROP TABLE IF EXISTS ai_calls`.execute(db)
  await sql`DROP TABLE IF EXISTS parse_results`.execute(db)
  await sql`DROP TABLE IF EXISTS processed_messages`.execute(db)
  await sql`DROP TABLE IF EXISTS message_media`.execute(db)
  await sql`DROP TABLE IF EXISTS messages`.execute(db)
  await sql`DROP TABLE IF EXISTS channel_settings`.execute(db)
  await sql`DROP TABLE IF EXISTS channels`.execute(db)
  await sql`DROP TABLE IF EXISTS users`.execute(db)

  await sql`DROP SEQUENCE IF EXISTS trade_ref_seq`.execute(db)

  for (const t of [
    'net_t', 'exec_mode', 'order_status', 'order_type_t', 'order_purpose', 'leg_status', 'leg_kind',
    'trade_status', 'action_status', 'side_t', 'action_type', 'parse_method', 'parse_route',
    'parser_kind', 'msg_status', 'channel_status', 'source_kind',
  ]) {
    await sql`DROP TYPE IF EXISTS ${sql.raw(t)}`.execute(db)
  }
}
