import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { Decimal } from 'decimal.js'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side } from 'shared/domain.js'
import { createExecutionPort } from '../src/execution/port.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { acquireSymbol, addLeg, openTrade } from '../src/state/trades.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from '../src/pipeline.js'
import type { ExtractSignalAction, ExtractSignalOutput } from '../src/ai/schema.js'

/**
 * AI-ветка пайплайна (задача 4 Ф2, research/ai-layer.md §8/§11/§12, task-4-brief.md):
 * - "AI-ветка (мок ai-proxy)" — детерминированные, БЫСТРЫЕ тесты против локального http-мока
 *   вместо живого ai-proxy: согласие/конфликт реконсиляции уже покрыты reconciler.test.ts (чистые
 *   юнит-тесты), здесь — именно ПРОВОДКА через processMessage (кэш/эскалация/гейт/деградация/
 *   реальное исполнение символ-less дельты к открытой позиции).
 * - "e2e — живой ai-proxy" — несколько РЕАЛЬНЫХ терсных сообщений форума (CH2, реальные
 *   картинки var/media) через ПОЛНЫЙ AI-пайплайн; skip, если прокси недоступен (тот же приём,
 *   что и ai-client.test.ts).
 */

// ---------------------------------------------------------------------------
// Мок ai-proxy: локальный http-сервер, очередь ответов (shift на каждый POST /v1/messages).
// ---------------------------------------------------------------------------

interface QueuedResponse {
  status: number
  body: unknown
}

interface MockAiServer {
  url: string
  queue: QueuedResponse[]
  /** Разобранные JSON-тела ВСЕХ полученных запросов, в порядке поступления (для проверки
   *  количества вызовов и того, какая модель запрашивалась — эскалация Sonnet→Opus). */
  requests: Array<{ model?: string }>
  close: () => Promise<void>
}

function startMockAiServer(): Promise<MockAiServer> {
  const queue: QueuedResponse[] = []
  const requests: Array<{ model?: string }> = []

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      try {
        requests.push(JSON.parse(raw) as { model?: string })
      } catch {
        requests.push({})
      }
      const next = queue.shift()
      if (!next) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock ai-proxy: очередь ответов пуста' } }))
        return
      }
      res.writeHead(next.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(next.body))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        queue,
        requests,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

/** Anthropic-формы ответа, который client.ts (callOnce) ожидает: content[tool_use] + usage. */
function toolUseResponse(output: ExtractSignalOutput, status = 200): QueuedResponse {
  return {
    status,
    body: {
      content: [{ type: 'tool_use', name: 'extract_signal', input: output }],
      usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 80 },
    },
  }
}

function baseOutput(overrides: Partial<ExtractSignalOutput> & Pick<ExtractSignalOutput, 'message_type' | 'actions'>): ExtractSignalOutput {
  return { understood: true, needs_human: false, image_used: false, confidence: 0.9, summary: '', ...overrides }
}

// ---------------------------------------------------------------------------
// Сидинг: канал/настройки/инструмент/сообщение/открытая позиция.
// ---------------------------------------------------------------------------

async function seedChannel(db: Kysely<DB>, opts: { id: number; ord: number; adapterId: string; enabled?: boolean }): Promise<void> {
  const now = new Date()
  await db
    .insertInto('channels')
    .values({
      id: opts.id,
      ord: opts.ord,
      key: `ch-${opts.id}`,
      source_kind: 'channel',
      topic_id: null,
      adapter_id: opts.adapterId,
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
    .execute()

  await db
    .insertInto('channel_settings')
    .values({
      channel_id: opts.id,
      enabled: opts.enabled ?? true,
      trade_size: '500',
      max_leverage: '20',
      cross_margin: true,
      no_sl_policy: 'attach_protective_sl',
      no_sl_buffer_sec: 0,
      add_sizing_mode: 'trade_size',
      mirror_manual_fraction: false,
      limit_ttl_sec: 604_800,
      updated_at: now,
    })
    .execute()
}

async function seedInstrument(db: Kysely<DB>, symbol: string): Promise<void> {
  const now = new Date()
  await db
    .insertInto('instruments')
    .values({
      symbol,
      network: 'testnet',
      base_coin: symbol.replace(/USDT$/, ''),
      status: 'Trading',
      qty_step: '0.01',
      min_qty: '0.01',
      tick_size: '0.0001',
      min_notional: '5',
      max_leverage: '50',
      leverage_step: '0.01',
      mmr: '0.005',
      refreshed_at: now,
    })
    .execute()
}

let tgIdSeq = 700_000

async function insertMessage(
  db: Kysely<DB>,
  params: { channelId: number; text: string; replyToMsgId?: number | null; tgMessageId?: number },
): Promise<PipelineMessage> {
  const tgMessageId = params.tgMessageId ?? tgIdSeq++
  const msgTs = new Date()
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: params.channelId,
      tg_message_id: tgMessageId,
      reply_to_msg_id: params.replyToMsgId ?? null,
      grouped_id: null,
      is_topic_message: false,
      text: params.text,
      has_media: false,
      media_kind: null,
      msg_ts: msgTs,
      raw: JSON.stringify({ id: tgMessageId, text: params.text }),
      status: 'received',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    id: row.id,
    channelId: params.channelId,
    tgMessageId,
    replyToMsgId: params.replyToMsgId ?? null,
    groupedId: null,
    text: params.text,
    mediaKind: null,
    msgTs,
  }
}

async function insertMedia(db: Kysely<DB>, messageId: string, tgMessageId: number, storagePath: string): Promise<void> {
  await db
    .insertInto('message_media')
    .values({
      id: randomUUID(),
      message_id: messageId,
      tg_message_id: tgMessageId,
      grouped_id: null,
      order_index: 0,
      storage_path: storagePath,
      media_type: 'image/jpeg',
      width: null,
      height: null,
      bytes: null,
      sha256: null,
      created_at: new Date(),
    })
    .execute()
}

/** message->action->trade->entry-лега->DryRunAdapter.placeEntry (тот же приём, что context.test.ts
 *  setupTradeContext) — открытая позиция, к которой должна матчиться символ-less/AI-дельта. */
async function seedOpenPosition(
  db: Kysely<DB>,
  params: { channelId: number; channelOrd: number; symbol: string; side: Side; entryPrice: string; qty: string },
): Promise<{ tradeId: string; actionId: string }> {
  const adapter = new DryRunAdapter()
  const msg = await insertMessage(db, { channelId: params.channelId, text: `seed ${params.symbol}` })
  const action = await db
    .insertInto('actions')
    .values({
      message_id: msg.id,
      channel_id: params.channelId,
      action_index: 0,
      type: 'open',
      side: params.side,
      symbol: params.symbol,
      method: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const trade = await openTrade(db, {
    channelId: params.channelId,
    symbol: params.symbol,
    side: params.side,
    openedActionId: action.id,
    openedMsgId: msg.id,
  })
  await acquireSymbol(db, { channelId: params.channelId, symbol: params.symbol, tradeId: trade.tradeId })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: params.qty })

  await adapter.placeEntry(db, {
    channelId: params.channelId,
    channelOrd: params.channelOrd,
    tgMessageId: msg.tgMessageId,
    actionIndex: 0,
    actionId: action.id,
    tradeId: trade.tradeId,
    legId: leg.legId,
    symbol: params.symbol,
    side: params.side,
    purpose: 'entry',
    orderType: 'market',
    qty: params.qty,
    price: params.entryPrice,
    leverage: '5',
    liqPrice: '0',
  })
  await db
    .updateTable('trades')
    .set({ status: 'open', avg_entry: params.entryPrice, size: params.qty, initial_size: params.qty })
    .where('id', '=', trade.tradeId)
    .execute()

  return { tradeId: trade.tradeId, actionId: action.id }
}

async function messageRow(db: Kysely<DB>, messageId: string) {
  return db.selectFrom('messages').selectAll().where('id', '=', messageId).executeTakeFirstOrThrow()
}

async function actionsFor(db: Kysely<DB>, messageId: string) {
  return db.selectFrom('actions').selectAll().where('message_id', '=', messageId).orderBy('action_index', 'asc').execute()
}

// ---------------------------------------------------------------------------
// Общий пул соединения БД для всего файла.
// ---------------------------------------------------------------------------

let db: Kysely<DB>
const deps: PipelineDeps = { executionPort: createExecutionPort('dry_run'), network: 'testnet', equity: '1000' }
const CH2_ID = 1
const CH2_ORD = 1

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

// ---------------------------------------------------------------------------
// AI-ветка (мок ai-proxy): каждый тест — своя fresh БД + свой мок-сервер с AI_PROXY_URL.
// ---------------------------------------------------------------------------

describe('pipeline — AI-ветка (мок ai-proxy)', () => {
  let mock: MockAiServer
  let savedAiProxyUrl: string | undefined

  beforeEach(async () => {
    await resetTestSchema(db)
    mock = await startMockAiServer()
    savedAiProxyUrl = process.env.AI_PROXY_URL
    process.env.AI_PROXY_URL = mock.url
  })

  afterEach(async () => {
    await mock.close()
    if (savedAiProxyUrl !== undefined) process.env.AI_PROXY_URL = savedAiProxyUrl
    else delete process.env.AI_PROXY_URL
  })

  it('символ-less дельта "Фикс половину" + AI-символ BTCUSDT + одна открытая позиция -> матчится, partial_close к правильной сделке', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')
    const { tradeId } = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: '1' })

    mock.queue.push(
      toolUseResponse(
        baseOutput({
          message_type: 'close_partial',
          confidence: 0.9,
          summary: 'Автор фиксирует половину лонга BTCUSDT.',
          actions: [
            {
              type: 'close',
              symbol: 'BTCUSDT',
              side: 'long',
              close_amount: { mode: 'fraction', value: 0.5, basis: 'original' },
              evidence_source: 'text',
            },
          ],
        }),
      ),
    )

    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Фикс половину' })
    await processMessage(db, message, deps)

    expect(mock.requests).toHaveLength(1) // confidence>=0.7, needs_human=false, символ известен -> БЕЗ эскалации

    const row = await messageRow(db, message.id)
    expect(row.status).toBe('executed')
    expect(row.method).toBe('ai')
    // Приёмка задачи 7: extract_signal.summary (обязательное поле схемы) теперь доходит до
    // messages.ai_summary — раньше пайплайн его нигде не читал (см. p2-task7-report.md), и
    // sparkles-саммари (design) никогда не показывался на реальных данных.
    expect(row.ai_summary).toBe('Автор фиксирует половину лонга BTCUSDT.')

    const actions = await actionsFor(db, message.id)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: 'partial_close', symbol: 'BTCUSDT', method: 'ai', status: 'executed', trade_id: tradeId })
  })

  it('гейт confidence=0.5: эскалация на Opus, Opus ТОЖЕ <0.7 -> needs_review low_confidence, 0 actions', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')

    const lowConfidenceAction: ExtractSignalOutput = baseOutput({
      message_type: 'modify_sl',
      confidence: 0.5,
      actions: [{ type: 'modify_sl', symbol: 'BTCUSDT', side: 'long', stop_loss: { mode: 'marker', marker: 'entry_price' }, evidence_source: 'text' }],
    })
    mock.queue.push(toolUseResponse(lowConfidenceAction)) // sonnet
    mock.queue.push(toolUseResponse({ ...lowConfidenceAction, confidence: 0.55 })) // opus — ТОЖЕ ниже гейта

    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Стоп на твх' })
    await processMessage(db, message, deps)

    expect(mock.requests).toHaveLength(2) // эскалация Sonnet->Opus состоялась (confidence<0.7)
    expect(mock.requests[0]?.model).toBe('claude-sonnet-4-5-20250929')
    expect(mock.requests[1]?.model).toBe('claude-opus-4-8')

    const row = await messageRow(db, message.id)
    expect(row.status).toBe('needs_review')
    expect(row.status_reason).toBe('low_confidence')
    expect(row.method).toBe('review')

    // Задача 6/7: needs_review теперь порождает СИНТЕТИЧЕСКУЮ actions-строку (0 ордеров, гейт
    // сработал ДО processIntent) — иначе оператор не видел бы в UI, что это сообщение непонято.
    const actions = await actionsFor(db, message.id)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ status: 'needs_review', skip_reason: 'low_confidence', method: 'review', trade_id: null })
  })

  it('needs_human=true (даже с валидным символом) -> needs_review needs_human, 0 actions', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')

    const needsHumanOutput: ExtractSignalOutput = baseOutput({
      message_type: 'modify_sl',
      needs_human: true,
      confidence: 0.95,
      actions: [{ type: 'modify_sl', symbol: 'BTCUSDT', side: 'long', stop_loss: { mode: 'marker', marker: 'entry_price' }, evidence_source: 'text' }],
    })
    mock.queue.push(toolUseResponse(needsHumanOutput)) // sonnet
    mock.queue.push(toolUseResponse(needsHumanOutput)) // opus — эскалация (needs_human триггерит её тоже)

    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Стоп на твх' })
    await processMessage(db, message, deps)

    expect(mock.requests).toHaveLength(2)
    const row = await messageRow(db, message.id)
    expect(row.status).toBe('needs_review')
    expect(row.status_reason).toBe('needs_human')
    // Задача 6/7: needs_review теперь видим оператору как actions-строка (0 ордеров).
    const actions = await actionsFor(db, message.id)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ status: 'needs_review', skip_reason: 'needs_human', method: 'review' })
  })

  it('эскалация Sonnet(0.6)->Opus(0.95, резолвит уверенно) -> УСПЕШНОЕ исполнение, method ai', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')
    const { tradeId } = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: '1' })

    const action: ExtractSignalAction = {
      type: 'close',
      symbol: 'BTCUSDT',
      side: 'long',
      close_amount: { mode: 'fraction', value: 0.5, basis: 'original' },
      evidence_source: 'text',
    }
    mock.queue.push(toolUseResponse(baseOutput({ message_type: 'close_partial', confidence: 0.6, actions: [action] }))) // sonnet: <0.7
    mock.queue.push(toolUseResponse(baseOutput({ message_type: 'close_partial', confidence: 0.95, actions: [action] }))) // opus: уверенно

    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Фикс половину' })
    await processMessage(db, message, deps)

    expect(mock.requests).toHaveLength(2)
    const row = await messageRow(db, message.id)
    expect(row.status).toBe('executed')
    expect(row.method).toBe('ai')
    const actions = await actionsFor(db, message.id)
    expect(actions[0]).toMatchObject({ type: 'partial_close', symbol: 'BTCUSDT', method: 'ai', trade_id: tradeId })
  })

  it('ДЕГРАДАЦИЯ: ai-proxy отвечает 400 (недоступен/сломан) -> CH2 needs_review ai_unavailable, 0 ордеров; CH1 в ТОМ ЖЕ прогоне исполняется нормально', async () => {
    const CH1_ID = 2
    const CH1_ORD = 2
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedChannel(db, { id: CH1_ID, ord: CH1_ORD, adapterId: 'ch1-structured' })
    await seedInstrument(db, 'AAAUSDT')

    // Мок отдаёт 400 (недоступен/сломан прокси) — client.ts классифицирует 400 как НЕретраибельный
    // (мгновенный throw, без 4-попыточного backoff) — тест остаётся быстрым, при этом наблюдаемый
    // исход (callExtractSignal бросает) идентичен исчерпанным ретраям на 5xx/сетевых сбоях.
    mock.queue.push({ status: 400, body: { error: { message: 'ai-proxy сломан (тест деградации)' } } })

    const ch2Message = await insertMessage(db, { channelId: CH2_ID, text: 'Фикс половину' })
    await processMessage(db, ch2Message, deps)

    const ch2Row = await messageRow(db, ch2Message.id)
    expect(ch2Row.status).toBe('needs_review')
    expect(ch2Row.status_reason).toBe('ai_unavailable')
    expect(ch2Row.method).toBe('review')
    // Задача 6/7: деградация AI тоже теперь оставляет видимую actions-строку (needs_review,
    // reason ai_unavailable) — оператор видит В UI, что именно эти сообщения не были обработаны.
    const ch2Actions = await actionsFor(db, ch2Message.id)
    expect(ch2Actions).toHaveLength(1)
    expect(ch2Actions[0]).toMatchObject({ status: 'needs_review', skip_reason: 'ai_unavailable', method: 'review' })
    const ch2Orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', CH2_ID).execute()
    expect(ch2Orders).toHaveLength(0)

    // CH1 — детерминированный путь, НИКОГДА не зовёт AI: тот же (сломанный) AI_PROXY_URL его не касается.
    const ch1Text = '#AAA/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const ch1Message = await insertMessage(db, { channelId: CH1_ID, text: ch1Text })
    await processMessage(db, ch1Message, deps)

    const ch1Row = await messageRow(db, ch1Message.id)
    expect(ch1Row.status).toBe('executed')
    expect(ch1Row.method).toBe('auto')
    const ch1Actions = await actionsFor(db, ch1Message.id)
    expect(ch1Actions[0]?.status).toBe('executed')
    const ch1Orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', CH1_ID).execute()
    expect(ch1Orders.length).toBeGreaterThan(0)

    expect(mock.requests).toHaveLength(1) // ровно один запрос — CH1 мок вообще не трогал
  })

  it('modify_tp (tp_set): числовая замена TP-лесенки -> старые TP-ордера отменены, новые созданы', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')
    const { tradeId } = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: '1' })

    mock.queue.push(
      toolUseResponse(
        baseOutput({
          message_type: 'modify_tp',
          confidence: 0.9,
          actions: [
            {
              type: 'modify_tp',
              symbol: 'BTCUSDT',
              side: 'long',
              take_profits: [{ value: 62000 }, { value: 63000 }],
              evidence_source: 'text',
            },
          ],
        }),
      ),
    )

    // Гейт AI_LEXICON_RE ch2.adapter.ts матчит "следующие цели" -> route 'ai' (текст — только
    // маршрутизация детерминированного адаптера, СЕМАНТИКУ действия задаёт мок-ответ выше).
    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Следующие цели 62000, 63000' })
    await processMessage(db, message, deps)

    const row = await messageRow(db, message.id)
    expect(row.status).toBe('executed')

    const tpOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('trade_id', '=', tradeId)
      .where('purpose', '=', 'tp')
      .where('status', '=', 'submitted')
      .execute()
    expect(tpOrders).toHaveLength(2)
    // NUMERIC(30,10) возвращает полный масштаб колонки ('62000.0000000000') — сравниваем через
    // Decimal, а не строкой (тот же приём, что pipeline.test.ts: avg_entry).
    const prices = tpOrders.map((o) => new Decimal(o.price ?? '0').toString()).sort()
    expect(prices).toEqual(['62000', '63000'])
  })

  it('cancel_order (cancel_pending): отменяет висящий pending add-ордер сделки', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'BTCUSDT')
    const { tradeId, actionId } = await seedOpenPosition(db, {
      channelId: CH2_ID,
      channelOrd: CH2_ORD,
      symbol: 'BTCUSDT',
      side: 'long',
      entryPrice: '60000',
      qty: '1',
    })

    // Висящий (ещё не исполненный) лимитный add-ордер — то, что должен отменить cancel_pending.
    await db
      .insertInto('orders')
      .values({
        trade_id: tradeId,
        leg_id: null,
        action_id: actionId,
        channel_id: CH2_ID,
        symbol: 'BTCUSDT',
        order_link_id: 'TEST-PENDING-ADD-1',
        purpose: 'add',
        side: 'long',
        order_type: 'limit',
        reduce_only: false,
        qty: '0.5',
        price: '58000',
        status: 'submitted',
        submitted_at: new Date(),
      })
      .execute()

    mock.queue.push(
      toolUseResponse(
        baseOutput({
          message_type: 'cancel_order',
          confidence: 0.9,
          actions: [{ type: 'cancel_order', symbol: 'BTCUSDT', side: 'long', evidence_source: 'text' }],
        }),
      ),
    )

    // Тот же приём, что и в тесте tp_set — текст только маршрутизирует детерминированный
    // адаптер в route 'ai' (AI_LEXICON_RE: "закрыва"), реальное действие задаёт мок.
    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Закрываю' })
    await processMessage(db, message, deps)

    const cancelled = await db.selectFrom('orders').selectAll().where('order_link_id', '=', 'TEST-PENDING-ADD-1').executeTakeFirstOrThrow()
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelled_at).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// e2e — живой ai-proxy: несколько РЕАЛЬНЫХ терсных сообщений форума CH2 (реальные картинки).
// ---------------------------------------------------------------------------

const AI_PROXY_URL = process.env.AI_PROXY_URL ?? 'http://127.0.0.1:8317'

async function liveProxyAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${AI_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    return res.status > 0
  } catch {
    return false
  }
}

describe('pipeline — e2e живой ai-proxy (реальные форум-сообщения CH2)', () => {
  const CHANNEL_ID = 1962583820 // реальный форум (research/ai-layer.md), тема 173666
  const CHANNEL_ORD = 1
  let available = false

  beforeAll(async () => {
    available = await liveProxyAvailable()
    if (!available) console.warn('[pipeline-ai e2e] ai-proxy недоступен — живой e2e пропущен')
  })

  beforeEach(async () => {
    await resetTestSchema(db)
    if (!available) return
    await seedChannel(db, { id: CHANNEL_ID, ord: CHANNEL_ORD, adapterId: 'ch2-freeform' })
    await seedInstrument(db, 'SOLUSDT')
    await seedOpenPosition(db, { channelId: CHANNEL_ID, channelOrd: CHANNEL_ORD, symbol: 'SOLUSDT', side: 'long', entryPrice: '150', qty: '10' })
  })

  it(
    '3 реальных терсных сообщения (карточки WEEX SOLUSDT: 221372/221410/221437) -> AI резолвит символ из картинки, method=ai',
    async () => {
      if (!available) return // явный skip, как в ai-client.test.ts

      const cases = [
        { id: 221372, text: 'Фикс половину \nСтоп в бу' },
        { id: 221410, text: '1🎯стоп на твх' },
        { id: 221437, text: '2🎯' },
      ]

      let methodAiWithSol = 0
      for (const c of cases) {
        const message = await insertMessage(db, { channelId: CHANNEL_ID, text: c.text, tgMessageId: c.id })
        await insertMedia(db, message.id, c.id, `var/media/ch-1962583820-t173666/${c.id}_0.jpg`)
        await processMessage(db, message, deps)

        const row = await messageRow(db, message.id)
        const actions = await actionsFor(db, message.id)
        console.log(
          `[e2e live] id=${c.id} status=${row.status} method=${row.method} reason=${row.status_reason} actions=%o`,
          actions.map((a) => ({ type: a.type, symbol: a.symbol, method: a.method, status: a.status })),
        )

        if (row.method === 'ai' && actions.some((a) => a.symbol === 'SOLUSDT')) methodAiWithSol++
      }

      console.log(`[e2e live] итог: ${methodAiWithSol}/${cases.length} сообщений method=ai с символом SOLUSDT из картинки`)
      expect(methodAiWithSol).toBeGreaterThan(0)
    },
    120_000,
  )
})
