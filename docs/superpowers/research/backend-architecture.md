I have everything I need. All prior reports, the critique, the reference doc, the design inventory, and the live infra configs are read. Writing the report now.

Note: my final message below is the deliverable itself.

---

# Архитектура бэкенда AI‑копитрейдинга (NestJS + PostgreSQL) — production‑спека

Опирается на проверенные факты прошлого раунда (Bybit UTA 2.0 / one‑way / cross / пустой кошелёк; `orderLinkId ≤36`, `110072`=dup=success, `110043`=set‑leverage no‑op=success; ai‑proxy дропает `system`, кэширует user‑блоки, SPOF/502; `status='Trading'`‑гейт; maxLev clamp по сети исполнения). Закрывает блокеры **B1, B4, B5, B6, B7** и риски **R5–R8, R10**, а также пробелы 1–8 из critique. Стек: Node ≥22, pnpm, NestJS, Postgres (docker compose), пакет `telegram` (GramJS) уже стоит.

Ключевое инженерное решение, снимающее B4: **идентичность ордера выводится из координат сообщения `(channelOrd, tgMessageId, actionIndex, purpose, legIndex)`, а не из свежесозданного `tradeId`.** `TR‑1042` — только человекочитаемый ярлык, он в `orderLinkId` не участвует.

---

## 0. Топология процессов (что отдельный воркер и почему)

Низкий объём (2–3 сигнала/день/канал), но требования строгие: строгий порядок на канал, единственный писатель на биржу, единственная MTProto‑сессия. Поэтому **монолитная кодовая база (pnpm workspace, общие Nest‑модули), но 3 рантайм‑процесса**, каждый — single‑instance в MVP:

```
┌───────────────┐   raw msg (INSERT messages + NOTIFY)   ┌────────────────────┐
│  tg-ingest    │ ─────────────────────────────────────► │      engine        │
│ (GramJS user- │                                         │  pipeline+state+   │
│  bot, 1 инст) │ ◄──── backfill watermark (channels)     │  execution+recon+  │
└───────────────┘                                         │  scheduler (1 инст)│
        ▲                                                  └─────────┬──────────┘
        │ MTProto (read-only, TG_SESSION)                            │ Bybit REST+WS (private/public)
        │                                                            │ domain_events (INSERT+NOTIFY)
   Telegram                                                          ▼
                                          ┌────────────────────────────────────┐
   browser ◄── socket.io / REST ─────────►│   api (NestJS HTTP+WS, 1 инст)      │
                                          │   REST + WS gateway + auth          │
                                          │   LISTEN domain_events → push       │
                                          └────────────────────────────────────┘
                                                          │
                                          ┌───────────────┴───────────────┐
                                          │ postgres  │  ai-proxy (SPOF)   │
                                          └───────────────────────────────┘
```

- **`tg-ingest`** — отдельный процесс, потому что держит единственную MTProto‑сессию с собственным жизненным циклом reconnect/backfill; горизонтально не масштабируется (иначе дубли апдейтов). Падение TG не должно ронять исполнение. Пишет только `messages`/`message_media`/`processed_messages` и двигает `channels.last_seen_message_id`.
- **`engine`** — единственный писатель к бирже (упрощает rate‑limit, идемпотентность, строгий порядок), держит Bybit private/public WS, ведёт `state` (позиции, `symbol_ownership`, trade/leg), гоняет пайплайн parse→ai→decide→risk→execute→reconcile и планировщик. Публикует `domain_events` для UI.
- **`api`** — HTTP REST + socket.io gateway + auth. Не пишет в биржу и в state; только читает БД и ретранслирует `domain_events` (LISTEN/NOTIFY) в браузер. Может масштабироваться под чтение (WS‑бридж — sticky).
- **Шина** — сам Postgres: durable‑очередь на `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` для латентности, транзакционный outbox (`orders`, `domain_events`). **Redis/BullMQ не вводим** (KISS: один stateful‑сервис — Postgres; SPOF и так один — ai‑proxy). Scale‑out на Redis — задокументированный, но отложенный путь.
- **Библиотека доступа к БД:** Kysely (или Drizzle) + `pg` — нужны `SKIP LOCKED`, advisory‑lock и точная `NUMERIC`‑арифметика; Prisma для этого неудобна. DDL ниже — чистый SQL, ORM‑агностичный. **Все деньги/цены/qty — `NUMERIC`, никогда float.**

---

## 1. Карта модулей NestJS

Общие Nest‑модули (в `libs/`), собираются в 3 бинарника (`apps/api`, `apps/engine`, `apps/tg-ingest`). Границы = «одна причина меняться + чёткий порт».

| Модуль | Процесс | Ответственность | Зависит от | Почему отдельный |
|---|---|---|---|---|
| **config** | все | zod‑валидация env на старте, типизированный `AppConfig`, `EXECUTION_MODE` | — | единая точка отказа конфигурации; падать на старте, не в рантайме |
| **db** | все | пул `pg`, Kysely, миграции, репозитории, транзакции, advisory‑lock helper | config | инфраструктура, не бизнес |
| **observability** | все | pino‑логгер (correlationId), `audit_log`, Prometheus‑метрики | db | сквозной, не должен зависеть от домена |
| **domain** | все | сущности/агрегаты (Trade, Leg, Order), FSM‑гварды, value‑objects (Symbol, Price, Qty), enum'ы | — | чистое ядро; тестируется без I/O |
| **ingestion** | tg-ingest | GramJS клиент, realtime‑хэндлеры (New/Edit/Delete), backfill, склейка альбомов, фильтр topic 173666, FloodWait | db, observability | единственная MTProto‑сессия, свой lifecycle |
| **normalization** | engine | lowercase/trim, `ё→е/э→е`, канонизация тикеров (алиасы+`1000`/`1000000`‑фолбэк), Unicode‑границы, извлечение чисел (nbsp/narrow) | domain | дешёвый детерминированный слой до парсера/AI |
| **parsing** | engine | реестр `ChannelAdapter` (CH1/CH2), детерминированные интенты + `route/confidence` | domain, normalization, bybit(instruments), state | новый канал = новый адаптер, ядро не трогается |
| **ai** | engine | клиент ai‑proxy (Anthropic‑совм.), сборка prompt (инструкция+схема в 1‑м user‑блоке с `cache_control`), кэш разбора, эскалация Sonnet→Opus, VCR‑режим | config, db, observability | SPOF‑изоляция, деградация, запись `ai_calls` |
| **reconciler-parse** | engine | слияние deterministic⊕ai в единое `decision` (владелец поля, конфликт→skip) | parsing, ai, domain | exactly‑once гейт двух путей (B4) |
| **state** | engine | агрегаты Trade/Leg, `positions`‑зеркало, `symbol_ownership` (атомарный захват), матчинг дельт | db, domain | «источник истины» модели позиции |
| **risk** | engine | **чистые функции**: sizing, выбор плеча (liq за SL), clamp, guards (stale/adverse/minNotional/exposure cap) | domain, bybit(instruments) | детерминизм, свойства‑тесты, никакого I/O |
| **execution** | engine | `ExecutionPort` (DryRun/Bybit), детерминированный `orderLinkId`, транзакционный outbox‑диспетчер, трактовка `110072/110043` | bybit, state, risk, db | единая точка ветвления dry/live; единственный писатель |
| **bybit** | engine (+api для чтения) | REST‑клиент (HMAC), private+public WS, token‑bucket rate‑limiter, реестр `instruments` (кэш `status='Trading'`, maxLev по сети) | config, db | инкапсуляция биржи; порт для моков |
| **reconciliation** | engine | старт‑реконсиляция биржа↔журнал, периодический дрейф, cancel‑all при size→0 (R8) | bybit, state, execution | восстановление после рестарта/ручных действий |
| **realtime** | api | socket.io gateway, LISTEN `domain_events`, троттлинг тикеров, снапшот‑ре‑гидратация, backpressure | db, auth | мост «сервер→браузер», sticky, single WS‑бридж |
| **rest** | api | контроллеры (channels/actions/positions/history/settings) | db, auth | HTTP‑поверхность из дизайна |
| **auth** | api | bcrypt, JWT в httpOnly‑cookie, guard REST+WS, CSRF | config, db | безопасность, отдельно от бизнеса |
| **scheduler** | engine | cron: TTL‑свип лимиток, периодич. реконсиляция, пересчёт статистики каналов | reconciliation, state, execution | явные таймеры, отдельно от хот‑паса |

---

## 2. Полный DDL PostgreSQL

```sql
-- ============ РАСШИРЕНИЯ / ENUM'ы / SEQUENCES ============
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TYPE source_kind      AS ENUM ('channel','forum_topic');
CREATE TYPE channel_status   AS ENUM ('active','paused','error');
CREATE TYPE msg_status       AS ENUM ('received','normalized','parsed','decided',
                                      'executing','executed','skipped','needs_review','noise','failed');
CREATE TYPE parser_kind      AS ENUM ('deterministic','ai');
CREATE TYPE parse_route      AS ENUM ('execute','ai','skip','noise');
CREATE TYPE parse_method     AS ENUM ('auto','ai','review');       -- UI Method
CREATE TYPE action_type      AS ENUM ('open','add','close','partial_tp','partial_close',
                                      'modify_sl','modify_tp','cancel_order','tp_hit','sl_hit','close_all','hold');
CREATE TYPE side_t           AS ENUM ('long','short');
CREATE TYPE action_status    AS ENUM ('pending','executing','executed','skipped','needs_review','failed');
CREATE TYPE trade_status     AS ENUM ('pending','open','partially_closed','closed','cancelled','skipped');
CREATE TYPE leg_kind         AS ENUM ('entry','add');
CREATE TYPE leg_status       AS ENUM ('pending','working','partially_filled','filled','cancelled','rejected');
CREATE TYPE order_purpose    AS ENUM ('entry','add','tp','sl','close','cancel');
CREATE TYPE order_type_t     AS ENUM ('market','limit');
CREATE TYPE order_status     AS ENUM ('created','pending_submit','submitted','partially_filled',
                                      'filled','rejected','cancelled','expired');
CREATE TYPE exec_mode        AS ENUM ('dry_run','live');
CREATE TYPE net_t            AS ENUM ('testnet','mainnet');

CREATE SEQUENCE trade_ref_seq START 1042;   -- TR-1042 первый; человекочитаемый id сделки

-- ============ AUTH ============
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,               -- bcrypt; сидируется из .env upsert на старте
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ КАНАЛЫ ============
CREATE TABLE channels (
  id                    BIGINT PRIMARY KEY,          -- TG channel id (2088626562)
  ord                   SMALLINT NOT NULL UNIQUE,    -- ординал для orderLinkId (01..99), стабилен навсегда
  key                   TEXT NOT NULL UNIQUE,        -- 'ch-2088626562', 'ch-1962583820-t173666'
  source_kind           source_kind NOT NULL,
  topic_id              INT,                          -- 173666 для форума, иначе NULL
  adapter_id            TEXT NOT NULL,                -- какой ChannelAdapter ('ch1-structured','ch2-freeform')
  title                 TEXT,
  handle                TEXT,
  status                channel_status NOT NULL DEFAULT 'active',
  last_seen_message_id  BIGINT NOT NULL DEFAULT 0,    -- backfill watermark (gap #1)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_settings (
  channel_id            BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  enabled               BOOLEAN  NOT NULL DEFAULT false,      -- "Copy trading" toggle (per-channel dry gate)
  trade_size            NUMERIC(20,8) NOT NULL,               -- фиксированный notional-фолбэк ($)
  max_leverage          NUMERIC(6,2)  NOT NULL,               -- потолок clamp
  default_leverage      NUMERIC(6,2),                         -- опц.
  -- B7: "cross" НЕ биржевой режим (в UTA он аккаунт-уровневый). Логический риск-лимит:
  equity_share_pct      NUMERIC(6,3),                         -- доля equity на канал (бывший "cross")
  -- решения заказчика, конфигурируемые (рецензент оспорил дефолты):
  no_sl_policy          TEXT NOT NULL DEFAULT 'skip'          -- skip|attach_from_next|buffer|default_sl (B2)
                        CHECK (no_sl_policy IN ('skip','attach_from_next','buffer','default_sl')),
  no_sl_buffer_sec      INT NOT NULL DEFAULT 0,               -- окно ожидания SL, если buffer
  add_sizing_mode       TEXT NOT NULL DEFAULT 'trade_size'    -- trade_size|risk|orig_fraction (R10)
                        CHECK (add_sizing_mode IN ('trade_size','risk','orig_fraction')),
  max_symbol_notional   NUMERIC(20,8),                        -- потолок совокупной экспозиции/символ (R10)
  mirror_manual_fraction BOOLEAN NOT NULL DEFAULT false,      -- B5: зеркалить "фикс 50%" или трактовать как event
  limit_ttl_sec         INT NOT NULL DEFAULT 604800,          -- R2: защитный потолок 7 дней
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ СООБЩЕНИЯ ============
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      BIGINT NOT NULL REFERENCES channels(id),
  tg_message_id   BIGINT NOT NULL,
  topic_id        INT,
  grouped_id      TEXT,                       -- album (склейка по groupedId)
  reply_to_msg_id BIGINT,                     -- reply-parent (может быть вне окна — gap #3)
  text            TEXT NOT NULL DEFAULT '',
  normalized_text TEXT,                       -- заполняется normalization
  has_media       BOOLEAN NOT NULL DEFAULT false,
  media_kind      TEXT,
  fwd_from        TEXT,
  views           INT,
  msg_ts          TIMESTAMPTZ NOT NULL,       -- t_msg (message.date) — критично для market-входов
  edit_count      INT NOT NULL DEFAULT 0,     -- UpdateEditChannelMessage (gap #2)
  edited_ts       TIMESTAMPTZ,
  deleted         BOOLEAN NOT NULL DEFAULT false,  -- UpdateDeleteChannelMessages
  status          msg_status NOT NULL DEFAULT 'received',
  status_reason   TEXT,
  method          parse_method,               -- решение reconciler (auto|ai|review)
  raw             JSONB NOT NULL,             -- сырой апдейт для реплея/бэктеста
  correlation_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, tg_message_id)          -- идемпотентность приёма
);
CREATE INDEX idx_msg_channel_status ON messages (channel_id, status);
CREATE INDEX idx_msg_channel_tgid   ON messages (channel_id, tg_message_id);
CREATE INDEX idx_msg_grouped        ON messages (grouped_id) WHERE grouped_id IS NOT NULL;
CREATE INDEX idx_msg_ts             ON messages (msg_ts);
-- очередь пайплайна: незавершённые сообщения (durable queue, SKIP LOCKED)
CREATE INDEX idx_msg_pipeline ON messages (channel_id, tg_message_id)
  WHERE status IN ('received','normalized','parsed','decided','executing');

CREATE TABLE message_media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tg_message_id BIGINT NOT NULL,
  grouped_id    TEXT,
  order_index   INT NOT NULL DEFAULT 0,      -- "Image N" для альбомов
  storage_path  TEXT NOT NULL,              -- temp/tg-dump/.../media/<id>.jpg (или объектное хранилище)
  media_type    TEXT NOT NULL DEFAULT 'image/jpeg',
  width         INT, height INT, bytes INT,
  sha256        TEXT,                        -- дедуп/кэш-ключ vision
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_message ON message_media (message_id);

-- Идемпотентность приёма на самом краю (до создания richer messages-строки при redelivery)
CREATE TABLE processed_messages (
  channel_id   BIGINT NOT NULL,
  message_id   BIGINT NOT NULL,             -- tg_message_id
  content_hash TEXT NOT NULL,               -- sha256(text + media_ids) — детект правок
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

-- ============ РАЗБОР ============
CREATE TABLE parse_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  parser        parser_kind NOT NULL,        -- deterministic | ai (у одного message может быть оба)
  adapter_id    TEXT,
  route         parse_route NOT NULL,
  confidence    NUMERIC(4,3) NOT NULL,
  intents       JSONB NOT NULL,              -- ParsedIntent[] (см. channel-adapters §10)
  reason        TEXT,                        -- no_SL | symbol_not_trading | symbol_unknown_needs_vision | ...
  needs_vision  BOOLEAN NOT NULL DEFAULT false,
  prompt_version TEXT,                       -- только для parser='ai'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_parse_message ON parse_results (message_id);

CREATE TABLE ai_calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID REFERENCES messages(id) ON DELETE SET NULL,
  parse_result_id UUID REFERENCES parse_results(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,               -- claude-sonnet-4-5 | claude-opus-4-8
  prompt_version TEXT NOT NULL,
  request_hash  TEXT NOT NULL,               -- application cache key (см. §11)
  input_tokens              INT NOT NULL DEFAULT 0,
  cache_creation_input_tokens INT NOT NULL DEFAULT 0,
  cache_read_input_tokens     INT NOT NULL DEFAULT 0,
  output_tokens             INT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  latency_ms    INT NOT NULL,
  http_status   INT,
  attempt       INT NOT NULL DEFAULT 1,
  cache_hit     BOOLEAN NOT NULL DEFAULT false,
  escalated     BOOLEAN NOT NULL DEFAULT false,  -- sonnet→opus
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_message ON ai_calls (message_id);
CREATE INDEX idx_ai_model_time ON ai_calls (model, created_at);
CREATE INDEX idx_ai_reqhash ON ai_calls (request_hash);

-- Кэш разбора (VCR + дедуп + golden set)
CREATE TABLE ai_cache (
  request_hash  TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response      JSONB NOT NULL,             -- нормализованный extract_signal
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ ДЕЙСТВИЯ (плоский слой для Actions-таблицы и timeline) ============
CREATE TABLE actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id    BIGINT NOT NULL REFERENCES channels(id),
  action_index  INT NOT NULL,               -- индекс интента в сообщении (мульти-символ/мульти-op)
  type          action_type NOT NULL,
  side          side_t,
  symbol        TEXT,                        -- BYBITSYMBOL или NULL (unknown→needs_review)
  pair          TEXT,                        -- отображаемое 'BTCUSDT'
  method        parse_method NOT NULL,       -- auto|ai|review (UI Method-колонка)
  trade_id      UUID REFERENCES trades(id),  -- заполняется при резолве владельца
  pct           NUMERIC(6,3),                -- '50%' для partial
  params        JSONB NOT NULL DEFAULT '{}', -- нормализованные детали (markers, entry range, tps...)
  detail        TEXT,                        -- UI summary
  status        action_status NOT NULL DEFAULT 'pending',
  skip_reason   TEXT,                        -- symbol_owned_by_other_channel | no_SL | out_of_range | ...
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at   TIMESTAMPTZ,
  UNIQUE (message_id, action_index)          -- exactly-once на действие
);
CREATE INDEX idx_action_channel_time ON actions (channel_id, created_at DESC);
CREATE INDEX idx_action_trade  ON actions (trade_id);
CREATE INDEX idx_action_symbol ON actions (symbol);
CREATE INDEX idx_action_type   ON actions (type);
CREATE INDEX idx_action_status ON actions (status);

-- ============ СДЕЛКИ / ЛЕГИ ============
CREATE TABLE trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  human_ref     TEXT NOT NULL UNIQUE,        -- 'TR-1042' = 'TR-'||nextval('trade_ref_seq')
  seq           BIGINT NOT NULL UNIQUE,
  channel_id    BIGINT NOT NULL REFERENCES channels(id),
  symbol        TEXT NOT NULL,
  side          side_t NOT NULL,
  status        trade_status NOT NULL DEFAULT 'pending',
  opened_action_id UUID REFERENCES actions(id),
  opened_msg_id UUID REFERENCES messages(id),
  avg_entry     NUMERIC(30,10),              -- текущий средневзвешенный вход (с учётом лег) — маркер "твх" (gap #7)
  size          NUMERIC(30,10) NOT NULL DEFAULT 0,   -- текущий совокупный размер
  initial_size  NUMERIC(30,10),
  leverage      NUMERIC(6,2),
  margin_mode   TEXT NOT NULL DEFAULT 'cross',
  realized_pnl  NUMERIC(30,10) NOT NULL DEFAULT 0,   -- для Win Rate/History (gap #5)
  fees_paid     NUMERIC(30,10) NOT NULL DEFAULT 0,
  is_win        BOOLEAN,                     -- выставляется при закрытии: net realized_pnl>0
  opened_at     TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_trade_channel_status ON trades (channel_id, status);
CREATE INDEX idx_trade_symbol_status  ON trades (symbol, status);
CREATE INDEX idx_trade_history        ON trades (channel_id, closed_at DESC) WHERE status IN ('closed','cancelled');

-- Модель "объём/лега" (B6): один добор = одна лега; "один объём" = qty одной леги
CREATE TABLE trade_legs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id          UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  leg_index         INT NOT NULL,           -- 0=entry, 1..=доборы
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
);
CREATE INDEX idx_leg_trade ON trade_legs (trade_id);

-- ============ ОРДЕРА (транзакционный OUTBOX) ============
CREATE TABLE orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id      UUID REFERENCES trades(id),
  leg_id        UUID REFERENCES trade_legs(id),
  action_id     UUID NOT NULL REFERENCES actions(id),
  channel_id    BIGINT NOT NULL REFERENCES channels(id),
  symbol        TEXT NOT NULL,
  order_link_id TEXT NOT NULL UNIQUE,        -- ДЕТЕРМИНИРОВАННЫЙ (§4); гарантия exactly-once
  bybit_order_id TEXT,
  purpose       order_purpose NOT NULL,      -- entry|add|tp|sl|close|cancel
  side          side_t NOT NULL,
  order_type    order_type_t NOT NULL,
  reduce_only   BOOLEAN NOT NULL DEFAULT false,
  qty           NUMERIC(30,10),
  price         NUMERIC(30,10),
  trigger_price NUMERIC(30,10),
  tp_index      INT,                         -- уровень лесенки
  time_in_force TEXT NOT NULL DEFAULT 'GTC',
  status        order_status NOT NULL DEFAULT 'created',
  ret_code      INT,                         -- 0 | 110072(dup→ok) | 110043 | reject-код
  ret_msg       TEXT,
  ttl_expires_at TIMESTAMPTZ,                -- R2: защитный потолок для лимиток
  submit_attempts INT NOT NULL DEFAULT 0,
  submitted_at  TIMESTAMPTZ,
  filled_at     TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- диспетчер outbox: неотправленные ордера
CREATE INDEX idx_order_dispatch ON orders (created_at)
  WHERE status IN ('created','pending_submit');
CREATE INDEX idx_order_bybitid  ON orders (bybit_order_id) WHERE bybit_order_id IS NOT NULL;
CREATE INDEX idx_order_trade    ON orders (trade_id);
-- быстрый cancel-all по символу (R8) и TTL-свип
CREATE INDEX idx_order_open_sym ON orders (symbol, reduce_only)
  WHERE status IN ('submitted','partially_filled');
CREATE INDEX idx_order_ttl      ON orders (ttl_expires_at)
  WHERE status IN ('submitted') AND ttl_expires_at IS NOT NULL;

CREATE TABLE executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID REFERENCES orders(id),
  trade_id      UUID REFERENCES trades(id),
  leg_id        UUID REFERENCES trade_legs(id),
  bybit_exec_id TEXT NOT NULL UNIQUE,        -- идемпотентность фила из WS/history
  order_link_id TEXT,
  symbol        TEXT NOT NULL,
  side          side_t NOT NULL,
  exec_qty      NUMERIC(30,10) NOT NULL,
  exec_price    NUMERIC(30,10) NOT NULL,
  closed_size   NUMERIC(30,10) NOT NULL DEFAULT 0,  -- >0 ⇒ закрывающий фил
  leaves_qty    NUMERIC(30,10) NOT NULL DEFAULT 0,
  exec_fee      NUMERIC(30,10) NOT NULL DEFAULT 0,
  exec_pnl      NUMERIC(30,10) NOT NULL DEFAULT 0,
  exec_type     TEXT,                        -- Trade | ...
  is_maker      BOOLEAN,
  exec_ts       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exec_trade ON executions (trade_id);
CREATE INDEX idx_exec_order ON executions (order_id);

-- ============ ВЛАДЕНИЕ СИМВОЛОМ (решение #1, атомарный захват) ============
CREATE TABLE symbol_ownership (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  channel_id  BIGINT NOT NULL REFERENCES channels(id),
  trade_id    UUID NOT NULL REFERENCES trades(id),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
-- один активный владелец на символ на весь аккаунт (one-way физически это гарантирует)
CREATE UNIQUE INDEX uq_symbol_active ON symbol_ownership (symbol) WHERE released_at IS NULL;

-- ============ ЗЕРКАЛО ПОЗИЦИЙ (реконсиляция + realtime + Active Positions) ============
CREATE TABLE positions (
  symbol          TEXT PRIMARY KEY,          -- one-way ⇒ одна запись/символ
  trade_id        UUID REFERENCES trades(id),
  channel_id      BIGINT REFERENCES channels(id),
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
  position_status TEXT,                      -- Normal | Liq | ...
  bybit_seq       BIGINT,                    -- водяной знак для порядка WS↔REST
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pos_channel ON positions (channel_id) WHERE size <> 0;

-- ============ РЕЕСТР ИНСТРУМENTОВ (кэш instruments-info, гейт status='Trading') ============
CREATE TABLE instruments (
  symbol        TEXT NOT NULL,
  network       net_t NOT NULL,
  base_coin     TEXT NOT NULL,
  status        TEXT NOT NULL,               -- ГЕЙТ: только 'Trading' (GRASS/EIGEN на TN = 'Closed')
  qty_step      NUMERIC(30,10) NOT NULL,
  min_qty       NUMERIC(30,10) NOT NULL,
  tick_size     NUMERIC(30,10) NOT NULL,
  min_notional  NUMERIC(20,8)  NOT NULL DEFAULT 5,
  max_leverage  NUMERIC(6,2)   NOT NULL,     -- по СЕТИ исполнения (TN≠MN)
  leverage_step NUMERIC(6,2)   NOT NULL DEFAULT 0.01,
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, network)
);

-- ============ REALTIME / АУДИТ ============
CREATE TABLE domain_events (               -- outbox для WS + реплей UI
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,              -- 'position.upsert','action.new','channel.stats',...
  aggregate    TEXT NOT NULL,             -- 'position','action','channel',...
  aggregate_id TEXT,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ                 -- NULL = ещё не отправлено (для catch-up после reconnect api)
);
CREATE INDEX idx_events_unpub ON domain_events (id) WHERE published_at IS NULL;

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor          TEXT NOT NULL,            -- system|admin|exchange|telegram
  action         TEXT NOT NULL,           -- 'order.submit','trade.close','settings.update','reconcile.fix'
  entity_type    TEXT,
  entity_id      TEXT,
  correlation_id UUID,
  channel_id     BIGINT,
  before         JSONB,
  after          JSONB,
  meta           JSONB,
  message        TEXT
);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_corr   ON audit_log (correlation_id);
CREATE INDEX idx_audit_ts     ON audit_log (ts DESC);

-- Глобальное состояние (execution mode при live-переключении, курсоры реконсиляции)
CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Как схема закрывает UI (frontend‑inventory §6/§9):**
- **Win Rate** = `count(*) FILTER (is_win) / count(*)` по `trades` где `status='closed'` для канала → `channel.stats`.
- **Active Positions** = `count(*)` в `positions` где `channel_id=? AND size<>0`.
- **Messages/Actions счётчики** — `count` по `messages`/`actions` на канал.
- Фильтры Actions (период/тип/сторона/поиск) — индексы `idx_action_*` + `created_at`; поиск по паре/`TR‑ID` через `actions.symbol` + `trades.human_ref`.
- **Доливки** (решение #6) — `actions.type='add'` с тем же `trade_id`; в UI это ещё один `open` в той же `TR‑x` (новая `trade_legs`‑строка).

---

## 3. Машины состояний

### 3.1 Message FSM
```
received ─normalization─► normalized ─parse(det+ai)─► parsed ─reconcile─► decided
   │                                                                        │
   │                                                     ┌──────────────────┼───────────────┐
   │ noise-route                                         │ execute-route    │ needs_review  │ skip
   ▼                                                     ▼                  ▼               ▼
 noise                                              executing           needs_review     skipped
                                                        │
                                     все actions терминальны? ─► executed  |  часть failed ─► failed
```
- **Инициатор:** `engine`. Каждый переход — в одной DB‑транзакции, `messages.status` двигается вместе с записью `parse_results`/`actions`.
- **`received→normalized→parsed→decided`** — детерминированно, до любого вызова биржи.
- **`decided→executing`** — только если хотя бы один action прошёл гейт (listed+Trading, SL по политике, владение символом, confidence). Переход в `executing` фиксируется в транзакции **ДО** вызова Bybit (см. §4).
- **`needs_review`** — AI `needs_human`/`symbol=UNKNOWN`/конфликт парсеров/ai‑proxy down для CH2. Не исполняется, ждёт человека, шлёт `action.skipped`.
- **`noise`** — обзор/чат/промо/медиа‑only.
- **При рестарте:** сообщения в нетерминальных статусах (`received…executing`) переигрываются из durable‑очереди (`idx_msg_pipeline`, `SKIP LOCKED`); повторный разбор идемпотентен по `UNIQUE(message_id, action_index)` и детерминированному `orderLinkId`. `executing` реконсилируется против биржи (был ли ордер реально отправлен — по `orders.order_link_id` в `order/realtime`/`order/history`).

### 3.2 Trade FSM
```
pending ──entry filled──► open ──partial close/tp fill──► partially_closed
   │                        │                                   │
   │ entry cancelled/TTL     └──────── size→0 ──────────────────┤
   ▼                                                            ▼
cancelled                                                     closed
   ▲                                                            ▲
   │ gate fail (no SL / symbol owned / not Trading)             │ size→0 & cancel-all reduceOnly (R8)
 skipped ◄──────────────────────────────────────────────────────
```
- **Инициатор переходов:** `state` в `engine`, драйвится **фактом с биржи** (WS `position`/`execution`), не сообщением. `pending→open` — по первому филлу entry‑леги. `open↔partially_closed` — по `execution.closedSize>0` при `position.size>0`. `→closed` — `position.size→0` (тогда же `symbol_ownership.released_at=now()`, cancel‑all reduceOnly/SL по символу — R8, и вычисление `is_win`).
- **`skipped`** — гейт до исполнения (владение символом другим каналом B3, no‑SL B2, `status≠'Trading'`).
- **При рестарте:** `pending/open/partially_closed` реконсилируются: `position/list` (size>0 ⇒ жива, сверка `createdTime`), `order/realtime` (что висит), `execution/list` (доборка realized). Расхождение → биржа = источник истины, журнал чинится (`reconcile.fix` в audit).

### 3.3 Order FSM
```
created ─dispatch(tx persisted)─► pending_submit ─Bybit call─► submitted ─fill─► partially_filled ─► filled
   │                                    │                          │
   │                                    │ retCode 110072(dup)      │ cancel / TTL / cancel-all
   │                                    ▼ =success→submitted       ▼
   │                              rejected(non-dup retCode)     cancelled
   └──────────────────────────────────────────────────────────► expired (TTL, лимитка не залилась)
```
- **Инициатор:** outbox‑диспетчер `execution`. `created` пишется в транзакции с `messages→executing`. Диспетчер берёт `created/pending_submit` через `FOR UPDATE SKIP LOCKED`, ставит `pending_submit`, зовёт биржу, по ответу → `submitted`/`rejected`. `110072`/`110043` → трактуются как success (§4). Филлы двигают статус из `executions` (WS).
- **При рестарте:** `pending_submit` — **неопределённое состояние** (мог уйти на биржу или нет). Реконсилируется по детерминированному `order_link_id`: `GET order/realtime` + `order/history` → если ордер там есть, `submitted`/фактический статус; если нет — повторная отправка (тот же `orderLinkId`, дубль невозможен).

---

## 4. Идемпотентность (блокер B4) — exactly‑once

**Проблема (из critique B4):** `orderLinkId=TR<tradeId>-…` ломается, если процесс упал между отправкой ордера и персистом `tradeId` — при рестарте новый `tradeId` → новый id → вторая позиция. Плюс два пути (детерминированный `execute` и AI) могут выдать интент по одному сообщению.

**Решение — идентичность из координат сообщения, а не из tradeId:**

```
orderLinkId = 'K' + ord2 + '-' + b(tgMessageId) + '-' + actIdx2 + '-' + purpose + legIdx
```
- `ord2` — `channels.ord`, 2 цифры (стабилен навсегда, назначается один раз).
- `b(tgMessageId)` — десятичный id (наши ≤7 цифр); если строка суммарно > 36 — base36‑кодирование id (`221452→"4rl8"`).
- `actIdx2` — индекс действия в сообщении (00..99) — покрывает мульти‑символ/мульти‑op (B‑случаи E2/E4).
- `purpose` — `E`ntry/`A`dd/`T`p/`S`l/`C`lose/`X`cancel; `legIdx` — уровень лесенки/номер добора.

Пример: `K02-221452-00-E0`, `K02-221452-00-T1`, `K02-221452-01-S0` — 16–17 символов, ≤36, charset `[A-Za-z0-9_-]` ✓. **`TR‑1042` в id не участвует** — минтится независимо и поздно.

**Почему exactly‑once даже при обоих парсерах:** и детерминированный, и AI‑путь для одного `(message, actionIndex, purpose, leg)` вычисляют **один и тот же** `orderLinkId`. Второй insert упадёт на `orders.order_link_id UNIQUE`; если оба всё же дошли до биржи — Bybit вернёт `retCode 110072`, который трактуем как success. Плюс `actions.UNIQUE(message_id, action_index)` не даёт продублировать само действие. Reconciler‑parse (§1) вообще выбирает **одно** decision на action (владелец поля: числа — детерминированный при совпавшем шаблоне; символ из картинки/reply/маркеры — AI; конфликт symbol/side/type → `needs_review`, не исполнять).

**Транзакционные границы (outbox):** `orders` — сам outbox.
1. **Tx1 (решение):** `INSERT actions … ON CONFLICT DO NOTHING` + `INSERT orders(status='created', order_link_id=…)` + `UPDATE messages SET status='executing'` + `INSERT domain_events`. Всё атомарно. Биржу здесь **не** зовём.
2. **Диспетчер:** `SELECT … FOR UPDATE SKIP LOCKED` по `status IN('created','pending_submit')` → `pending_submit` → вызов Bybit → по ответу `submitted`/`rejected`, `bybit_order_id`, `ret_code`. Идемпотентность выхода за пределы БД обеспечивает `orderLinkId`.

**Коды:** `110072` (dup linkId) и `110043` (set‑leverage no‑op) → в whitelist «идемпотентный успех». `10001/110017` (tick/qty/minNotional) → `rejected`, action→`skipped(reason)`. `10006/10018` (rate limit) → backoff, повтор (тот же id). Rejection по балансу (`110012/110045`) → `rejected`, алерт.

---

## 5. Конкурентность

**Два сообщения по одному символу одновременно.** Двухуровневая защита:

1. **Строгий последовательный порядок на КАНАЛ.** Дельты CH2 (`Фикс половину`, `Стоп на твх`) зависят от состояния позиции, которое меняют предыдущие сообщения того же канала; reply/state‑матчинг требует монотонности. Поэтому в `engine` — **одна логическая lane на канал**: сообщения канала обрабатываются строго по возрастанию `tg_message_id`. Реализация без Redis: воркер берёт из очереди «следующее необработанное сообщение канала» под `pg_advisory_xact_lock(hashtext('chan:'||channel_id))` + `FOR UPDATE SKIP LOCKED`. Разные каналы идут параллельно.
2. **Атомарный захват символа (решение #1, B3).** На уровне исполнения — не «последовательность», а **атомарная гонка за символ** между каналами:
```sql
INSERT INTO symbol_ownership (symbol, channel_id, trade_id)
VALUES ($sym, $ch, $trade)
ON CONFLICT (symbol) WHERE released_at IS NULL DO NOTHING
RETURNING id;
-- пусто ⇒ символ уже занят: если владелец = наш канал → это add/delta к своей сделке;
--        иначе → action.status='skipped', skip_reason='symbol_owned_by_other_channel' (B3, коллизия SOL)
```
Partial unique index `uq_symbol_active` физически гарантирует одного владельца — совпадает с one‑way‑реальностью аккаунта (две позиции по символу невозможны). Дельта без входа к чужому символу → `needs_review` (осиротевшая дельта, critique B3).

**Почему advisory‑lock, а не только `SELECT FOR UPDATE`:** порядок обработки канала нужно держать до создания trade‑строки (иначе два «Long SOL» одного канала гонятся за одной legой). `FOR UPDATE` на `symbol_ownership` не помогает, пока строки нет — а `ON CONFLICT` на partial‑unique это и решает для межканальной гонки. Advisory‑lock по каналу — для внутриканального порядка. Комбинация покрывает оба класса.

---

## 6. Реалтайм + финальный WS‑контракт

**socket.io, не native ws.** Обоснование: встроенные reconnection с backoff, rooms/namespaces (позиции vs каналы vs actions), ack‑колбэки для запроса снапшота, heartbeat, автоматический fallback — всё, что критично для «Positions streams like Bybit». Native `ws` дал бы меньший оверхед, но пришлось бы вручную писать reconnect/heartbeat/rooms; при 1 админе и низком объёме оверхед socket.io незначим, надёжность важнее (KISS в смысле «меньше своего кода»).

**Мост Bybit→браузер:** `engine` держит Bybit private WS (`position/order/execution/wallet`) и public `tickers.<symbol>` (только по символам открытых позиций). Он — единственный, кто пишет `positions` и эмитит `domain_events`. `api` делает `LISTEN` на `domain_events` (или Postgres NOTIFY) и ретранслирует в socket.io‑комнаты.

- **Троттлинг mark:** тикеры летят ~каждые 100–300 мс, `markPrice` **не в каждой дельте** → в `engine` держим last‑merged snapshot per symbol; на сервере коалесцируем и шлём `ticker.update` не чаще **1 раза/250 мс на символ** (batched). uPnL/ROI считаем от смёрженного mark.
- **Backpressure:** per‑symbol «drop‑oldest, keep‑latest» (тикеры идемпотентны — важна последняя цена, не история). Position/order/execution события — durable в `domain_events`, не дропаются.
- **Reconnect Bybit:** экспоненциальный backoff, повторный `op:auth` (`expires=now+10s`, `sign=HMAC(secret,"GET/realtime"+expires)`), ре‑subscribe, дельты применяются по `seq` (монотонный водяной знак) поверх REST‑снапшота.
- **Reconnect браузера:** на `connect` клиент получает `positions.snapshot` (из `positions` + REST catch‑up) и `execution.mode`; `domain_events.published_at IS NULL` даёт catch‑up пропущенных событий.

**Финальный контракт (сверен 1:1 с frontend‑inventory §7; помечены дополнения под gaps):**
```ts
// server → client
'positions.snapshot' { positions: Position[]; stats: PositionStats }        // on connect / re-hydrate
'position.upsert'    { position: Position }                                  // open/size/tp-sl change
'position.close'     { symbol: string; tradeRef: TradeRef; realizedPnl: number }
'ticker.update'      { symbol: string; mark: string;                         // throttled ≤4/s/symbol
                       uPnl?: number; roi?: string; liq?: string }
'message.new'        { channelId: ChannelId; message: Message }              // actions may be []
'message.parsed'     { channelId: ChannelId; messageId: string;
                       actions: MessageAction[]; method: ParseMethod; summary?: string }
'action.new'         { row: ActionRow }
'action.skipped'     { channelId: ChannelId; pair: string; reason: string }  // symbol_owned_by_other_channel|no_SL|out_of_range|parser_disagreement|symbol_not_trading
'channel.stats'      { channelId: ChannelId; msgCount: number; actionCount: number;
                       activePos: number; winRate?: string; status?: 'Active'|'Paused' }
'execution.mode'     { mode: 'dry_run' | 'live' }                            // topbar DRY-RUN badge
// ДОПОЛНЕНИЯ (закрывают frontend-gaps #2,#6):
'order.pending'      { channelId: ChannelId; symbol: string; tradeRef: TradeRef;
                       orderLinkId: string; price: string; ttlExpiresAt: string }  // pending-limits screen + TTL clock
'order.resolved'     { orderLinkId: string; status: 'filled'|'cancelled'|'expired'|'rejected' }

// client → server (ack)
'positions.request'  (cb: (snapshot) => void)
```
`ParseMethod` расширяется значением `'review'` (frontend‑gap #6, «Needs review» бейдж).

---

## 7. REST API

Выведено из реально рендерящихся экранов Admin.dc.html (+ frontend‑gaps #2/#3/#5). Base `/api`. Все ответы `{ data, ... }`; ошибки `{ error: { code, message } }`. Пагинация — cursor (`?cursor=&limit=`).

| Метод | Путь | Query | Ответ (TS) | Ошибки |
|---|---|---|---|---|
| POST | `/auth/login` | body `{username,password}` | `{ user:{username,role} }` + Set‑Cookie | 401 invalid_credentials, 429 |
| POST | `/auth/logout` | — | `204` | 401 |
| GET | `/auth/me` | — | `{ user }` | 401 |
| GET | `/channels` | — | `Channel[]` (со stats) | 401 |
| GET | `/channels/:id` | — | `Channel` (детально) | 401,404 |
| GET | `/channels/:id/messages` | `cursor,limit` | `{ items: Message[]; nextCursor?:string }` | 401,404 |
| GET | `/channels/:id/settings` | — | `ChannelSettings` | 401,404 |
| PATCH | `/channels/:id/settings` | body `Partial<ChannelSettings>` | `ChannelSettings` | 400 validation, 401,404 |
| GET | `/actions` | `channelId?,period?(all\|today\|7d\|30d),type?,side?,q?,cursor,limit` | `{ items: ActionRow[]; nextCursor? }` | 400,401 |
| GET | `/positions` | — | `{ positions: Position[]; stats: PositionStats }` | 401 |
| GET | `/positions/pending` | `channelId?` | `PendingOrder[]` (лимитки+TTL, gap #2) | 401 |
| GET | `/history` | `channelId?,side?,q?,cursor,limit` | `{ items: ClosedTrade[]; nextCursor? }` (gap #3/#5) | 401 |
| GET | `/trades/:ref` | — | `TradeDetail` (legs+orders+executions timeline) | 401,404 |
| GET | `/config/runtime` | — | `{ mode:'dry_run'\|'live'; tgStatus; bybitStatus; aiStatus }` (Settings screen, gap #1) | 401 |
| GET | `/health` | — | `{ status; db; bybit; ai; telegram }` | — (публично для compose healthcheck) |
| GET | `/metrics` | — | Prometheus text | — (internal net) |

```ts
type PendingOrder = { orderLinkId:string; channelId:ChannelId; symbol:string; side:Side;
  price:string; qty:string; tradeRef:TradeRef; createdAt:string; ttlExpiresAt:string };
type ClosedTrade = { tradeRef:TradeRef; channelId:ChannelId; channelName:string; symbol:string;
  side:Side; realizedPnl:number; isWin:boolean; openedAt:string; closedAt:string;
  legs:number; entryAvg:string };
type TradeDetail = { trade:ClosedTrade|OpenTrade; legs:LegRow[]; orders:OrderRow[]; executions:ExecRow[] };
```
`EXECUTION_MODE` и глобальный pause — **read‑only** в API (источник — env/`app_state`); UI их отображает, не редактирует (безопасность: переключение в live — только через деплой/env).

---

## 8. Auth

Один админ, `ADMIN_USERNAME`/`ADMIN_PASSWORD` из `.env`. На старте `api` делает upsert в `users` c `bcrypt`(cost 12) от пароля (пароль в открытом виде в БД не лежит).

- **Логин:** сверка bcrypt → выдаём **JWT (HS256, короткий exp 12h) в httpOnly + Secure + SameSite=Lax cookie** (не в localStorage — защита от XSS‑кражи токена). Refresh не нужен (один пользователь, повторный логин дёшев).
- **REST guard:** `AuthGuard` читает cookie, верифицирует JWT.
- **WS:** socket.io `allowRequest`/handshake‑middleware читает ту же cookie, верифицирует JWT до `connection`; без валидного токена — отказ. Токен не передаётся в query (не течёт в логи).
- **CSRF:** state‑changing REST (`PATCH settings`, `login`) — double‑submit CSRF‑токен (cookie `csrf` + заголовок `X-CSRF-Token`) поверх SameSite=Lax; GET‑и безопасны.
- **Rate‑limit** на `/auth/login` (например 5/min/IP) от брутфорса.

Лучше ли: для single‑admin это оптимальный минимум. Единственное усиление, которое стоит заложить — опциональный TOTP‑second‑factor (env‑флаг), т.к. система двигает деньги; но не в MVP.

---

## 9. Конфиг и секреты

**zod‑валидация на старте (`config`‑модуль), падать до приёма трафика.** Пример схемы:
```ts
const Env = z.object({
  NODE_ENV: z.enum(['development','production','test']),
  EXECUTION_MODE: z.enum(['dry_run','live']).default('dry_run'),
  DATABASE_URL: z.string().url(),
  // Bybit
  BYBIT_API_KEY: z.string().min(1),
  BYBIT_API_SECRET: z.string().min(1),
  BYBIT_NETWORK: z.enum(['testnet','mainnet']).default('testnet'),
  BYBIT_RECV_WINDOW: z.coerce.number().default(5000),
  // Telegram
  TG_APP_API_ID: z.coerce.number(),
  TG_APP_API_HASH: z.string().min(1),
  TG_SESSION: z.string().min(1),                 // StringSession — секрет, не в репо
  // AI proxy
  AI_PROXY_URL: z.string().url().default('http://127.0.0.1:8317'),
  AI_MODEL_PRIMARY: z.string().default('claude-sonnet-4-5'),
  AI_MODEL_ESCALATE: z.string().default('claude-opus-4-8'),
  AI_PROMPT_VERSION: z.string(),                 // фикс, входит в кэш-ключ; без даты/uuid
  // Auth
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  JWT_SECRET: z.string().min(32),
  // Guards (калибруемые)
  STALE_AFTER_SEC: z.coerce.number().default(120),
  MAX_ADVERSE_DRIFT: z.coerce.number().default(0.005),
  AI_CONFIDENCE_GATE: z.coerce.number().default(0.7),
}).refine(v => v.EXECUTION_MODE!=='live' || v.BYBIT_NETWORK, {message:'live requires explicit network'});
```

**.env (секреты/окружение):** всё выше — ключи Bybit, `TG_SESSION`, `TG_APP_*`, `JWT_SECRET`, `ADMIN_*`, `AI_PROXY_MANAGEMENT_KEY`, `EXECUTION_MODE`, `BYBIT_NETWORK`.
**БД (`channel_settings`, `app_state`):** per‑channel настройки (enabled/tradeSize/maxLev/defLev/equity_share/no_sl_policy/TTL/cap), пороги, курсоры реконсиляции, кэши инструментов. Правило: секреты и рантайм‑окружение — env; бизнес‑настройки, редактируемые из UI — БД.

**EXECUTION_MODE — ЕДИНАЯ точка ветвления (не россыпь if):**
```ts
interface ExecutionPort {
  placeOrder(o: OrderSpec): Promise<OrderResult>;
  cancelOrder(link: string, symbol: string): Promise<void>;
  cancelAll(symbol: string): Promise<void>;
  setLeverage(symbol: string, lev: number): Promise<void>;
  setTradingStop(s: TradingStopSpec): Promise<void>;
}
class BybitAdapter implements ExecutionPort { /* реальные REST-вызовы, HMAC */ }
class DryRunAdapter implements ExecutionPort {
  // пишет ТЕ ЖЕ строки orders/executions/positions в БД (status='submitted'→симулированный fill
  // по mark из tickers), эмитит те же domain_events, но НЕ зовёт биржу и retCode=0 всегда.
}
// DI-провайдер выбирает адаптер по EXECUTION_MODE один раз на старте:
{ provide: 'ExecutionPort',
  useClass: cfg.EXECUTION_MODE==='live' ? BybitAdapter : DryRunAdapter }
```
Весь `engine` знает только `ExecutionPort`. Dry‑run проходит по полному пути (sizing, orderLinkId, outbox, FSM, UI, реалтайм) — отличается только адаптером. Это же даёт бесплатный «shadow‑режим» для сверки с реальностью канала.

---

## 10. Отказоустойчивость

| Сценарий | Механизм |
|---|---|
| **Рестарт с открытыми позициями** | Старт‑реконсиляция (`reconciliation`): `position/list settleCoin=USDT` → size>0 ⇒ сделка жива, сверка `createdTime` с нашим Open; `order/realtime` → висящие entry/TP по `order_link_id`; `execution/list`/`order/history` → доборка realized; журнал чинится по бирже (audit `reconcile.fix`); ре‑subscribe WS c `seq`‑watermark. `pending_submit`‑ордера доразрешаются по детерминированному `orderLinkId` (есть на бирже → фиксируем статус; нет → повторная отправка, дубль невозможен). |
| **Обрыв Telegram на час (gap #1)** | `tg-ingest` reconnect (GramJS `connectionRetries`, backoff). После восстановления — **backfill**: `getMessages(entity,{minId=channels.last_seen_message_id, replyTo=topicId})` постранично, `FloodWait`→sleep. Пропущенные `close/стоп` во время обрыва доедут; сообщения ставятся в очередь в порядке id и обрабатываются последовательно. Watermark двигается только после успешного персиста. Если за час позиция должна была закрыться — Bybit WS/реконсиляция уже отразят size→0 независимо от TG. |
| **Падение ai‑proxy (SPOF, был 502)** | Ретраи (429/5xx/529 → backoff, 4 попытки; 400/404/413 — не ретраить). При недоступности: **CH1 детерминированный путь работает без AI** (символ всегда в `#TICKER`) — не блокируется. **CH2** сообщения без символа в тексте → `needs_review` (не исполнять!), алерт; очередь копится, при восстановлении переигрывается. Эскалация Opus недоступна → `needs_human`, не исполнять. Fail‑safe: система не действует вслепую. Квирки прокси (`system` дропается, кэш работает) не хардкодятся как вечные — за флагом. |
| **Отклонение ордера биржей** | `order` FSM → `rejected` c `ret_code/ret_msg`; action→`skipped(reason)`; `10001/110017` (tick/qty/minNotional) — детерминированные, не ретраить; `10006/10018` (rate) — backoff+retry (тот же `orderLinkId`); баланс `110012/110045` — алерт. `action.skipped` в UI c причиной. |
| **Ручное закрытие человеком в терминале Bybit** | Bybit private WS `position` → `size→0`. `state` закрывает `TR‑x` (`closed`), `symbol_ownership.released_at=now()`, и **cancel‑all по символу** (R8) — снимает наши висящие reduceOnly‑TP и conditional‑SL; вычисляет `is_win`; шлёт `position.close`. Биржа — источник истины. |
| **Автор редактирует уже исполненный сигнал (gap #2)** | `UpdateEditChannelMessage` → `edit_count++`, ре‑парс. Уже исполненные `(message,action_index)` **иммутабельны** (не отменяем/не амендим автоматически). Только **новые** `action_index`, которых не было, исполняются (тот же детерминированный `orderLinkId` защищает от дублей старых). Изменение чисел уже исполненного входа → `needs_review` + алерт (человек решает). `UpdateDeleteChannelMessages` → `messages.deleted=true`, позиции **не** трогаем (удаление поста ≠ команда закрытия). |
| **R8: position size→0** | Единый обработчик: на `position.size→0` (WS) — `ExecutionPort.cancelAll(symbol)` (снять reduceOnly‑TP + trading‑stop SL), release ownership, close trade. Идемпотентно (повторный cancel‑all по пустому символу — no‑op). |

---

## 11. Наблюдаемость

- **Структурный лог на сообщение** (pino, `correlation_id`=`messages.correlation_id`): одна цепочка `raw → normalized → parse(det) → parse(ai) → decision(method,conflict) → order.submit(retCode) → execution(fill)`. Каждый шаг — событие с `channelId, tgMessageId, correlationId, stage, durationMs`.
- **`ai_calls`** (см. DDL): `model, prompt_version, request_hash, input/cache_creation/cache_read/output tokens, cost_usd, latency_ms, http_status, attempt, cache_hit, escalated, error`. Стоимость считается из токенов по прайсу модели. Это же — сырьё для отчёта «$/1000», латентности p50/p95 (Sonnet p95 ~13.4 s — трекать), доли cache_read, доли эскалаций.
- **Метрики (Prometheus, `/metrics`):** `messages_processed_total{route}`, `parse_conflicts_total`, `orders_submitted_total{purpose,retCode}`, `orders_rejected_total{reason}`, `ai_call_latency_ms` (histogram), `ai_cost_usd_total`, `bybit_ws_reconnects_total`, `tg_backfill_gap_messages`, `symbol_ownership_conflicts_total{other_channel}`, `reconcile_fixes_total`, `open_positions`, `execution_mode`.
- **Audit_log** — все мутации (order.submit, trade.close, settings.update, reconcile.fix, cancel_all) с before/after.
- **Бэктест/golden set:** каждое сообщение персистентно (`messages.raw`, `message_media`), каждый AI‑ответ — в `ai_cache` (VCR). Golden set = ручная разметка ожидаемых `actions` по `message_id` (отдельная таблица/фикстура). CI гоняет `parsing`+`ai(VCR)` на 200‑сообщенном дампе → precision/recall извлечения, регрессии промпта (`prompt_version` в ключе кэша обеспечивает воспроизводимость). Реплей полного пайплайна на исторических ценах (`kline`) — оценка «сколько входов скипнули бы гварды».
- **Application‑cache‑ключ разбора:** `sha256(model + normalized_text + sorted(media_sha256[]) + reply_parent_id + hash(open_positions_snapshot) + prompt_version)` — открытые позиции в ключе, т.к. от них зависит резолюция символа терсных дельт.

---

## 12. Планировщик (`@nestjs/schedule` в `engine`)

| Джоба | Период | Действие |
|---|---|---|
| **TTL‑свип лимиток (R2)** | 1 мин | Отмена `orders` где `status='submitted' AND ttl_expires_at<now()`. TTL — **защитный потолок 7 дней** (`channel_settings.limit_ttl_sec`), т.к. автор держит лимитку 3+ дня. **Основная отмена — не по таймеру, а по явным сообщениям** («лимитка не актуальна» `221421`, «Другие лимитки больше не актуальны» `221432`) → `action.type='cancel_order'`. Таймер только страхует «забытые». |
| **Периодическая реконсиляция** | 2–5 мин | `position/list` + `order/realtime` vs журнал; расхождение → чинить по бирже, audit + алерт. Ловит пропущенные WS‑события и ручные вмешательства между рестартами. |
| **Пересчёт статистики каналов** | 1 мин (или по событию) | `winRate/msgCount/actionCount/activePos` → `channel.stats` (можно инкрементально по `domain_events`, cron — как страховка консистентности). |
| **Refresh instruments** | 6 ч | `instruments-info` по сети исполнения → `instruments` (status/maxLev/qtyStep дрейфуют; TN≠MN). |
| **Свип `domain_events`** | 30 с | Публикация `published_at IS NULL` (catch‑up, если `api` был отключён). |

Все джобы — идемпотентны и защищены `pg_advisory_lock` (только один экземпляр `engine` выполняет).

---

## 13. Тесты

- **Unit (чистые функции `risk`, без I/O):** sizing (`notional=(risk%·equity)/stopDistance`, фолбэк `trade_size`, `no SL→skip` по политике), выбор плеча (`lev=clamp(floor_to(step, 1/(d+MMR+buf)), 1, min(chanMax, instrMax))`), округления (floor qty к `qtyStep`, price к `tickSize`), дедуп close‑all. **Свойство‑тесты (fast‑check):** для любого валидного входа — `liqPrice` всегда за `SL` (long: liq≤SL; short: liq≥SL); `notional ≤ max_symbol_notional`; сумма `tpSize ≤ position size`; qty ≥ `minOrderQty` и notional ≥ 5.
- **Интеграция (парсеры на 200 сообщениях дампа как фикстурах):** прогон `parsing`+`normalization` на обоих `messages.jsonl` → сверка route/symbol/intents с золотой разметкой; проверка E1–E6 из channel‑adapters (символ по приоритету reply→state→coin→vision; мульти‑SL/мульти‑add сплит; `ё/е` нормализация; 0 ложных входов). БД — реальная (testcontainers Postgres), Bybit/AI — замоканы.
- **AI детерминированно (VCR):** записанные `extract_signal`‑ответы в `ai_cache`; тест бьёт по кэшу (0 сетевых вызовов), проверяет извлечение actions на golden‑30 (F1‑порог, регрессия при смене `prompt_version`). Реальный вызов ai‑proxy — только в отдельном (nightly) прогоне.
- **E2E на Bybit testnet:** полный вертикальный путь на **фикстурных сообщениях** → реальные ордера на testnet (после faucet‑пополнения владельцем): open→TP‑лесенка→SL→частичное закрытие→cancel‑all при size→0. Проверка `orderLinkId`‑идемпотентности (повторная отправка → `110072`=ok), реконсиляции после kill‑9 между outbox‑insert и submit. `EXECUTION_MODE=dry_run` E2E — без биржи, проверяет что DryRunAdapter пишет те же строки.
- **Что мокать:** Bybit REST/WS (кроме e2e), ai‑proxy (VCR), Telegram (фикстуры jsonl). **Что не мокать:** Postgres (testcontainers — advisory‑lock/SKIP LOCKED/partial‑unique важны для корректности), чистые функции `risk`, FSM‑гварды.

---

## 14. Docker compose

Добавляем к существующему `ai-proxy` сервисы `postgres`, `api`, `web`, воркеры `engine`, `tg-ingest`. Порядок старта через healthcheck‑зависимости; миграции — отдельный one‑shot.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: copytrade
      POSTGRES_PASSWORD: ${DB_PASSWORD:?}
      POSTGRES_DB: copytrade
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
    healthcheck:
      test: ["CMD-SHELL","pg_isready -U copytrade -d copytrade"]
      interval: 5s; timeout: 5s; retries: 10
    networks: [ internal ]

  migrate:                                   # one-shot: применяет миграции и выходит
    build: { context: ., dockerfile: apps/api/Dockerfile, target: migrate }
    command: ["node","dist/migrate.js"]
    environment: { DATABASE_URL: postgres://copytrade:${DB_PASSWORD}@postgres:5432/copytrade }
    depends_on: { postgres: { condition: service_healthy } }
    restart: "no"
    networks: [ internal ]

  ai-proxy: { ... как сейчас ..., networks: [ internal ] }   # уже есть; порт 8317 не менять

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    environment: [ DATABASE_URL=..., JWT_SECRET, ADMIN_*, EXECUTION_MODE,
                   BYBIT_*, AI_PROXY_URL=http://ai-proxy:8317 ]
    ports: [ "127.0.0.1:3000:3000" ]
    depends_on:
      postgres: { condition: service_healthy }
      migrate:  { condition: service_completed_successfully }
    healthcheck: { test: ["CMD","node","dist/healthcheck.js"], interval: 10s, retries: 5 }
    networks: [ internal ]

  engine:                                    # single-instance воркер; писатель к бирже
    build: { context: ., dockerfile: apps/engine/Dockerfile }
    environment: [ DATABASE_URL=..., BYBIT_*, BYBIT_NETWORK, AI_PROXY_URL=http://ai-proxy:8317,
                   EXECUTION_MODE, STALE_AFTER_SEC, MAX_ADVERSE_DRIFT, AI_CONFIDENCE_GATE ]
    depends_on:
      postgres:  { condition: service_healthy }
      migrate:   { condition: service_completed_successfully }
      ai-proxy:  { condition: service_healthy }
    deploy: { replicas: 1 }                  # НЕ масштабировать
    networks: [ internal ]

  tg-ingest:                                 # single-instance userbot (MTProto session)
    build: { context: ., dockerfile: apps/tg-ingest/Dockerfile }
    environment: [ DATABASE_URL=..., TG_APP_API_ID, TG_APP_API_HASH, TG_SESSION ]
    volumes: [ "./temp/tg-media:/app/media" ]  # скачанные картинки (message_media.storage_path)
    depends_on: { postgres: { condition: service_healthy },
                  migrate:  { condition: service_completed_successfully } }
    deploy: { replicas: 1 }
    networks: [ internal ]

  web:                                       # статика React (nginx), проксирует /api и /socket.io на api
    build: { context: ., dockerfile: apps/web/Dockerfile }
    ports: [ "127.0.0.1:8080:80" ]
    depends_on: [ api ]
    networks: [ internal ]

networks: { internal: {} }
volumes:  { pgdata: {} }
```
- **Сети:** всё в `internal`; наружу (loopback хоста) — только `web:8080`, `api:3000`, `ai-proxy:8317`. Bybit/Telegram — исходящие.
- **Порядок:** `postgres`(healthy)→`migrate`(completed)→`ai-proxy`(healthy)→`engine`/`api`/`tg-ingest`→`web`.
- **Миграции** — отдельный `migrate` one‑shot, не в рантайме воркеров (детерминизм, `service_completed_successfully`).
- **TG‑воркер** живёт в собственном контейнере `tg-ingest` (единственная сессия, свой volume под медиа). `ai-proxy` — как есть, порт 8317 не трогаем.

---

## 15. Фазы разработки

**Критика §13 референса.** Она даёт **горизонтальные слои**, не вертикальные срезы: «Фаза 0 — ingestion+схема+лог, всё dry‑run», «Фаза 1 — парсер», «Фаза 2 — LLM», «Фаза 3 — state», «Фаза 5 — исполнение». Проблемы: (1) до фазы 5 **нечего показать заказчику** и не снят ни один денежный риск; (2) фазы 0–2 «в вакууме» — парсер без state и без исполнения не проверяет ничего конечного; (3) UI (весь Admin.dc.html) вообще **не упомянут** как фаза, хотя это половина ТЗ; (4) нет фазы под B1‑B7/R‑блокеры (идемпотентность, symbol‑ownership, реконсиляция, cancel‑all) — самые рискованные части отложены на «фазу 5» скопом; (5) «dry‑run до фазы 5» откладывает интеграцию с биржей до конца, когда именно она — главный источник неизвестных.

**Мои фазы — вертикальные срезы, каждый демонстрируется заказчику и снимает конкретный риск:**

- **Ф0 — Скелет + видимый поток (demo: сообщения канала в реальном UI).** `config`(zod)+`db`(миграции всей схемы)+`observability`+auth+`api`+`web` (Channels/Messages экраны 1:1 из дизайна) + `tg-ingest` (realtime+backfill+альбомы+topic‑фильтр, пишет `messages`/`media`) + WS `message.new`. **Проверка:** заказчик логинится, видит живую ленту обоих каналов. **Риск снят:** B1‑часть (TG‑слой, gap #1/#3), инфраструктура, реалтайм‑каркас.

- **Ф1 — Детерминированный разбор CH1 в dry‑run (demo: сигнал→action→«сделка» без биржи).** `normalization`+`parsing`(CH1 adapter)+`reconciler`+`risk`(sizing/leverage чистые ф‑ии)+`execution` с **DryRunAdapter**+`state`(trades/legs/symbol_ownership)+Actions/Positions экраны. `orderLinkId`‑идемпотентность и outbox — здесь. **Проверка:** прогон дампа CH1 → в UI появляются actions с `TR‑x`, dry‑run позиции, Win Rate по симулированным закрытиям; повторный прогон не создаёт дублей. **Риск снят:** B4 (идемпотентность), решения #1/#4/#5, sizing/leverage корректность (свойство‑тесты).

- **Ф2 — AI‑слой + CH2 (demo: терсные «2🎯»/«Фикс половину» превращаются в actions).** `ai`(ai‑proxy клиент, prompt в user‑блоке+cache_control, эскалация, VCR‑кэш)+CH2 adapter+vision+reconciler‑конфликты+`needs_review`. **Проверка:** дамп CH2 через пайплайн → символ из картинки/reply/state резолвится, мульти‑символ сплитится, конфликт парсеров→`needs_review`; golden‑30 F1 в CI. **Риск снят:** B5/B6 (легиа/объёмы, ручные доли), R6 (атрибуция), R4 (деградация при 502 — проверяется отключением ai‑proxy: CH1 работает, CH2→review).

- **Ф3 — Live‑исполнение на testnet (demo: реальные ордера на Bybit testnet).** `BybitAdapter`+private/public WS bridge+`reconciliation`(старт+периодич.)+`scheduler`(TTL/stats)+cancel‑all(R8). `EXECUTION_MODE=live`, testnet, малый sizing. **Проверка:** e2e — открытие/лесенка TP/перенос SL/частичное закрытие/ручное закрытие в терминале→cancel‑all; kill‑9 между outbox и submit→реконсиляция без дублей. **Риск снят:** реальная интеграция биржи, R8, рестарт с позициями, ручные вмешательства.

- **Ф4 — Наблюдаемость, история, полировка (demo: History/Pending экраны, метрики, бэктест).** `/history`(closed‑pnl, gap #5), `/positions/pending`+TTL‑clock (gap #2), Settings экран (gap #1), метрики/дашборд, реплей‑бэктест на дампе, детектор аномалий/скоринг каналов. **Проверка:** заказчик видит realized PnL, Win Rate, pending‑лимитки с TTL, отчёт «$/1000 и сколько входов скипнули бы гварды». **Риск снят:** решение о переводе на mainnet принимается на данных, а не вслепую.

Каждая фаза — вертикальный срез (TG→parse→(ai)→state→execute→UI), демонстрируемый и снимающий именованный блокер/риск; следующий срез добавляет глубину, не переписывая предыдущий.

---

**Файлы, на которые опирается спека (абсолютные):** `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/design/project/Admin.dc.html` (источник REST/WS‑поверхности), `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/docker-compose.yml`, `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/ai-proxy.config.yaml`, `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/scripts/lib/tg.mjs` (каналы/topic), `/Users/vovilonn/Documents/work/work/bybit-copytrade-bot/temp/tg-dump/*/messages.jsonl` (200 фикстур). Проверенные факты и critique — из `.../tasks/wzx7po192.output` (reports: bybit‑execution, channel‑adapters, ai‑layer, frontend‑inventory + critique).