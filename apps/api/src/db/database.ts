import { Kysely, PostgresDialect, type Generated } from 'kysely'
import pg from 'pg'
import type {
  Side,
  TradeStatus,
  LegKind,
  LegStatus,
  OrderPurpose,
  OrderType,
  OrderStatus,
  ActionType,
  ActionStatus,
  ParserKind,
  Route,
} from 'shared/domain.js'

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
    /**
     * Последнее ИСТОРИЧЕСКОЕ сообщение канала: движок разбирает только `tg_message_id` СТРОГО
     * больше этого значения, всё остальное помечает `archived` без разбора и без вызова AI
     * (миграция 008 — живой инцидент с прогоном всей истории через AI-парсер).
     * `Generated`, потому что у колонки есть DEFAULT 0: вставке канала её передавать не обязательно.
     */
    process_from_message_id: Generated<number>
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
    // Задача 12b (002_media_repair): счётчик попыток ремонтного прохода и метка окончательного
    // отказа (сообщение удалено в Telegram / медиа объективно недоступно) — см. миграцию.
    media_repair_attempts: Generated<number>
    media_repair_failed_at: Date | null
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
    /**
     * true — размер сделки ВСЕГДА берётся из `trade_size`, даже если в сигнале указан риск в
     * процентах (иначе объём выводится из риска и стоп-дистанции, см. risk/sizing.ts).
     * `Generated`, потому что у колонки есть DEFAULT false (миграция 009).
     */
    force_trade_size: Generated<boolean>
    limit_ttl_sec: number
    updated_at: Date
  }
  instruments: {
    symbol: string
    // net_t — тот же enum, что и остальная схема (001_initial.ts + 005_demo_network.ts):
    // 'testnet' | 'mainnet' | 'demo'.
    network: 'testnet' | 'mainnet' | 'demo'
    base_coin: string
    status: string
    // NUMERIC-колонки — string (см. комментарий выше про точность).
    qty_step: string
    min_qty: string
    tick_size: string
    min_notional: string
    max_leverage: string
    leverage_step: string
    // Задача 1 (003_instruments_mmr): MMR tier1 из risk-limit, nullable — см. миграцию.
    mmr: string | null
    refreshed_at: Generated<Date>
  }
  // Задача 5 (Ф1): trades/trade_legs/symbol_ownership — состояние сделок и атомарный захват
  // символа внутри канала (apps/engine/src/state/trades.ts). side/status-энумы переиспользованы
  // из shared/domain.ts (DRY, единый источник правды с engine).
  trades: {
    // seq — БЕЗ Generated: у колонки в схеме нет DEFAULT (значение берётся из nextval('trade_ref_seq')
    // на стороне JS одним вызовом вместе с human_ref, см. openTrade — граблю Ф0 из task-2-report.md).
    id: Generated<string>
    human_ref: string
    seq: number
    channel_id: number
    symbol: string
    side: Side
    status: Generated<TradeStatus>
    opened_action_id: string | null
    opened_msg_id: string | null
    avg_entry: string | null
    size: Generated<string>
    initial_size: string | null
    leverage: string | null
    margin_mode: Generated<string>
    realized_pnl: Generated<string>
    fees_paid: Generated<string>
    is_win: boolean | null
    opened_at: Date | null
    closed_at: Date | null
    updated_at: Generated<Date>
    // Реконсиляция с Bybit (007_reconcile_sync): needs_review — сделка разошлась с биржей и требует
    // разбора оператором; manual_override — оператор вмешался руками на бирже, после чего канал
    // больше не двигает SL/TP этой сделки. Обе с DEFAULT false ⇒ Generated<> (см. messages выше).
    needs_review: Generated<boolean>
    manual_override: Generated<boolean>
  }
  trade_legs: {
    id: Generated<string>
    trade_id: string
    leg_index: number
    kind: LegKind
    source_message_id: string | null
    source_action_id: string | null
    requested_qty: string
    filled_qty: Generated<string>
    avg_price: string | null
    notional: string | null
    status: Generated<LegStatus>
    opened_at: Date | null
    updated_at: Generated<Date>
  }
  symbol_ownership: {
    id: Generated<string>
    symbol: string
    channel_id: number
    trade_id: string
    acquired_at: Generated<Date>
    released_at: Date | null
  }
  // actions: плоский слой действий. Задача 6 использовала только как FK-якорь orders.action_id
  // (type/status оставались свободной строкой); задача 7 (reconciler/pipeline — парсер/оркестратор
  // действий) типизирует их ActionType/ActionStatus (shared/domain.ts), тот же DRY-приём, что и
  // у Side/TradeStatus/OrderPurpose выше. `method` оставлен строкой (как messages.method) —
  // полный parse_method вне фокуса этой задачи.
  actions: {
    id: Generated<string>
    message_id: string
    channel_id: number
    action_index: number
    type: ActionType
    side: Side | null
    symbol: string | null
    pair: string | null
    method: string
    trade_id: string | null
    pct: string | null
    params: Generated<unknown>
    detail: string | null
    status: Generated<ActionStatus>
    skip_reason: string | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
    executed_at: Date | null
  }
  // Задача 6 (Ф1): ExecutionPort/DryRunAdapter (apps/engine/src/execution/*) — транзакционный
  // outbox ордеров + зеркало исполнений/позиций. purpose/order_type/status переиспользуют
  // enum'ы из shared/domain.ts (тот же приём, что и Side/TradeStatus/LegKind/LegStatus выше).
  orders: {
    id: Generated<string>
    trade_id: string | null
    leg_id: string | null
    action_id: string
    channel_id: number
    symbol: string
    order_link_id: string
    bybit_order_id: string | null
    purpose: OrderPurpose
    side: Side
    order_type: OrderType
    reduce_only: Generated<boolean>
    qty: string | null
    price: string | null
    trigger_price: string | null
    tp_index: number | null
    time_in_force: Generated<string>
    status: Generated<OrderStatus>
    ret_code: number | null
    ret_msg: string | null
    ttl_expires_at: Date | null
    submit_attempts: Generated<number>
    submitted_at: Date | null
    filled_at: Date | null
    cancelled_at: Date | null
    created_at: Generated<Date>
    updated_at: Generated<Date>
  }
  executions: {
    id: Generated<string>
    order_id: string | null
    trade_id: string | null
    leg_id: string | null
    bybit_exec_id: string
    order_link_id: string | null
    symbol: string
    side: Side
    exec_qty: string
    exec_price: string
    closed_size: Generated<string>
    leaves_qty: Generated<string>
    exec_fee: Generated<string>
    exec_pnl: Generated<string>
    // exec_type — 'Trade' | 'Funding' | 'AdlTrade' | 'BustTrade' | 'Settle' (существует с 001_initial).
    // 'Funding' — не сделка: идёт только в комиссии, не влияет на размер/среднюю цену (см. 007).
    exec_type: string | null
    is_maker: boolean | null
    exec_ts: Date
    created_at: Generated<Date>
    // Реконсиляция с Bybit (007_reconcile_sync):
    // bybit_order_id — единственный ключ для джойна с /v5/position/closed-pnl (orderLinkId он не отдаёт);
    // source — 'ws' | 'rest': патч PnL из closed-pnl имеет право трогать ТОЛЬКО 'rest'-строки
    //   (у 'ws' есть точный execPnl на каждый филл, /v5/execution/list его не возвращает вовсе).
    //   DEFAULT 'ws' в схеме ⇒ Generated<>;
    // create_type — 'CreateByUser' | 'CreateByClosing' (закрытие из UI Bybit) | 'CreateByStopLoss' | ...;
    // bybit_seq — BIGINT, читается number'ом (см. setTypeParser INT8 выше), как positions.bybit_seq.
    bybit_order_id: string | null
    source: Generated<'ws' | 'rest'>
    create_type: string | null
    bybit_seq: number | null
  }
  // Зеркало позиций (реконсиляция + realtime + Active Positions, PK (channel_id, symbol)).
  // mark_price/liq_price/unrealised_pnl — реальный live-фид подключит задача 9; в Ф1
  // DryRunAdapter пишет только size/avg_price/leverage/stop_loss (см. dry-run.adapter.ts).
  positions: {
    channel_id: number
    symbol: string
    trade_id: string | null
    side: Side | null
    size: Generated<string>
    avg_price: string | null
    mark_price: string | null
    liq_price: string | null
    leverage: string | null
    position_im: string | null
    unrealised_pnl: string | null
    cur_realised_pnl: string | null
    take_profit: string | null
    stop_loss: string | null
    position_status: string | null
    bybit_seq: number | null
    updated_at: Generated<Date>
  }
  // Задача 7 (Ф1): parse_results — один ряд на каждый прогон adapter.parse() (apps/engine/src/
  // pipeline.ts), в т.ч. повторные при переобработке (история разборов, не UNIQUE по message_id —
  // см. комментарий в pipeline.ts). route/parser переиспользуют Route/ParserKind из shared/domain.ts
  // (тот же DRY-приём, что и Action*/Order*-типы выше). confidence — NUMERIC(4,3), строка, не number.
  parse_results: {
    id: Generated<string>
    message_id: string
    parser: ParserKind
    adapter_id: string | null
    route: Route
    confidence: string
    intents: Generated<unknown>
    reason: string | null
    needs_vision: Generated<boolean>
    prompt_version: string | null
    created_at: Generated<Date>
  }
  // Task 1 (мониторинг PnL/баланса, 006_wallet_snapshots.ts): снимки баланса demo-аккаунта,
  // которые пишет движок (Task 3) и читает GET /account/wallet (Task 2). channel_id NULL —
  // снапшот уровня всего аккаунта (единственный вид, который сейчас провижинится); non-null —
  // задел под будущие реальные субаккаунты на канал.
  wallet_snapshots: {
    id: Generated<string>
    channel_id: number | null
    total_equity: string
    available_balance: string
    currency: Generated<string>
    created_at: Generated<Date>
  }
  // Глобальное состояние (создана ещё 001_initial.ts, типизируется здесь впервые): key/value-хранилище
  // под execution mode при live-переключении и КУРСОРЫ РЕКОНСИЛЯЦИИ (007_reconcile_sync) — до какого
  // времени/страницы догнана история executions и closed-pnl после даунтайма.
  // value — JSONB, поэтому unknown (как domain_events.payload/actions.params выше): форму конкретного
  // курсора валидирует владеющий им модуль, а не типы БД.
  app_state: {
    key: string
    value: unknown
    updated_at: Generated<Date>
  }
  // остальные таблицы схемы (processed_messages, ai_calls, ai_cache, audit_log) объявляются здесь же
  // по мере использования в Ф1–Ф4. Пока созданы миграцией, но не типизированы — тесты, которым нужен
  // сырой SQL, используют sql`...`.
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  })
}
