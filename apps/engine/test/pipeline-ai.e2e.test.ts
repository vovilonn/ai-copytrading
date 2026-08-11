import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
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

  // Ровно тот инвариант, ради которого гейт вынесли в начало пайплайна: у выключенного канала
  // модель не должна вызываться ВООБЩЕ. Проверять это можно только здесь — в этом файле AI реально
  // включён и есть мок-сервер с журналом запросов; остальные тесты гоняются с aiEnabled=false и
  // на детерминированном CH1, где route==='ai' не возникает в принципе, поэтому доказать они
  // ничего не могут. Инцидент прода: 2268 вызовов на $22.73 при выключенном копировании.
  it('копирование выключено -> терсное сообщение CH2 НЕ уходит в модель: ноль запросов к ai-proxy', async () => {
    await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform', enabled: false })
    await seedInstrument(db, 'BTCUSDT')

    // Очередь мока СПЕЦИАЛЬНО пуста: любой запрос к нему вернул бы 500 — вторая страховка к
    // проверке mock.requests.
    const message = await insertMessage(db, { channelId: CH2_ID, text: 'Фикс половину' })
    await processMessage(db, message, deps)

    expect(mock.requests).toHaveLength(0)
    // ai_calls не типизирована в DB-интерфейсе (api/db/database.ts) — сырой SQL, как в других местах.
    const aiCalls = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ai_calls WHERE message_id = ${message.id}::uuid`.execute(db)
    expect(aiCalls.rows[0]?.n).toBe('0')

    const row = await messageRow(db, message.id)
    expect(row.status).toBe('skipped')
    expect(row.status_reason).toBe('copy_disabled')
    expect(row.method).toBeNull()

    // Ни разбора, ни действий — сообщение вообще не бралось в работу.
    const parses = await db.selectFrom('parse_results').selectAll().where('message_id', '=', message.id).execute()
    expect(parses).toHaveLength(0)
    expect(await actionsFor(db, message.id)).toHaveLength(0)
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

  // Живой случай прода 28.07.2026 (сообщение 221530, «Первый тейк по эфиру - 1943 / По Xrp - 1.08»):
  // названа ОДНА цель из подразумеваемых трёх, а тейк встал на ВЕСЬ объём позиции (XRP получил
  // ордер на 188.6 из 188.6). Ступень лесенки обязана считаться от исходного объёма, а не «поровну
  // на одну цель».
  describe('лесенка целей: названная ступень забирает долю, а не весь объём', () => {
    async function seedForLadder(qty: string, entryPrice = '60000') {
      await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
      await seedInstrument(db, 'BTCUSDT')
      return seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice, qty })
    }

    function tpResponse(take_profits: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
      return toolUseResponse(
        baseOutput({
          message_type: 'modify_tp',
          confidence: 0.9,
          actions: [{ type: 'modify_tp', symbol: 'BTCUSDT', side: 'long', take_profits, evidence_source: 'text', ...extra }],
        }),
      )
    }

    async function tpOrdersOf(tradeId: string) {
      return db
        .selectFrom('orders')
        .selectAll()
        .where('trade_id', '=', tradeId)
        .where('purpose', '=', 'tp')
        .where('status', '=', 'submitted')
        .orderBy('created_at', 'asc')
        .execute()
    }

    it('ОДНА названная цель -> тейк на ТРЕТЬ позиции, а не на весь объём', async () => {
      const { tradeId } = await seedForLadder('3')
      mock.queue.push(tpResponse([{ value: 62000, index: 1 }]))

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Первый тейк 62000' }), deps)

      const tps = await tpOrdersOf(tradeId)
      expect(tps).toHaveLength(1)
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('1') // треть от 3, а не 3
    })

    it('доля, названная автором, важнее дефолтной трети', async () => {
      const { tradeId } = await seedForLadder('10')
      mock.queue.push(tpResponse([{ value: 62000, index: 1, fraction: 0.3 }]))

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'На первой цели 62000 фикс 30%' }), deps)

      const tps = await tpOrdersOf(tradeId)
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('3')
    })

    it('автор назвал размер лесенки (две цели) -> ступень равна половине', async () => {
      const { tradeId } = await seedForLadder('10')
      mock.queue.push(tpResponse([{ value: 62000, index: 1 }], { tp_ladder_total: 2 }))

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Следующие цели 62000' }), deps)

      const tps = await tpOrdersOf(tradeId)
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('5')
    })

    it('три цели разом -> прежнее поведение: объём делится поровну', async () => {
      const { tradeId } = await seedForLadder('3')
      mock.queue.push(tpResponse([{ value: 62000 }, { value: 63000 }, { value: 64000 }]))

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Следующие цели 62000, 63000, 64000' }), deps)

      const tps = await tpOrdersOf(tradeId)
      expect(tps).toHaveLength(3)
      expect(tps.map((o) => new Decimal(o.qty ?? '0').toString())).toEqual(['1', '1', '1'])
    })

    it('вторая цель следующим сообщением НЕ сносит уже выставленную первую', async () => {
      const { tradeId } = await seedForLadder('3')
      mock.queue.push(tpResponse([{ value: 62000, index: 1 }]))
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Первый тейк 62000' }), deps)

      mock.queue.push(tpResponse([{ value: 63000, index: 2 }]))
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Второй тейк 63000' }), deps)

      const tps = await tpOrdersOf(tradeId)
      expect(tps.map((o) => new Decimal(o.price ?? '0').toString()).sort()).toEqual(['62000', '63000'])
    })

    it('цель по ТУ СТОРОНУ рынка не ставится: reduce-only лимитка исполнилась бы мгновенно', async () => {
      const { tradeId } = await seedForLadder('3')
      mock.queue.push(tpResponse([{ value: 59000, index: 1 }])) // ниже рынка для лонга
      const depsWithMark: PipelineDeps = { ...deps, getMarkPrice: async () => '60000' }

      const message = await insertMessage(db, { channelId: CH2_ID, text: 'Первый тейк 59000' })
      await processMessage(db, message, depsWithMark)

      expect(await tpOrdersOf(tradeId)).toHaveLength(0)
      const actions = await actionsFor(db, message.id)
      expect(actions[0]?.skip_reason).toBe('tp_beyond_market')
    })

    it('ступень меньше шага объёма -> лесенка не ставится и СТАРЫЕ цели не снимаются', async () => {
      const { tradeId } = await seedForLadder('0.001') // треть = 0.00033 < шага 0.001
      mock.queue.push(tpResponse([{ value: 62000, index: 1 }]))

      const message = await insertMessage(db, { channelId: CH2_ID, text: 'Первый тейк 62000' })
      await processMessage(db, message, deps)

      expect(await tpOrdersOf(tradeId)).toHaveLength(0)
      const actions = await actionsFor(db, message.id)
      expect(actions[0]?.skip_reason).toBe('zero_qty')
    })
  })

  // Доливка не трогала цели: они оставались выставлены на прежний объём, и после добора позиция
  // выходила по лесенке лишь частично, а остаток держался до стопа. Живые случаи ARB/INJ/MMT
  // (30-31.07.2026): лесенка покрывала 7-14% позиции.
  // Живой случай 11.08.2026 (XRP, msg 221579): «По Xrp после усреднения твх 1.03, там буду
  // скидывать доливку / Если что первый Таргет 1.048». Вход 479.7 + доливка 495 = позиция 974.7.
  // Бот прочитал «твх 1.03» как стоп-лосс (биржа его отвергла — для лонга в минусе он выше рынка),
  // выход доливки на 1.03 не поставил вовсе, а «первый таргет» посчитал от ПЕРВОГО входа: 159.9,
  // то есть 16% реальной позиции.
  describe('выход доливки на названной цене + лесенка от полного объёма', () => {
    async function seedWithAdd(entryQty: string, addQty: string) {
      await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
      await seedInstrument(db, 'BTCUSDT')
      const seeded = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: entryQty })
      // Доливка: лега + рост позиции (то же, что делает handleAdd + филл с биржи).
      await addLeg(db, { tradeId: seeded.tradeId, legIndex: 1, kind: 'add', requestedQty: addQty, status: 'filled' })
      await db
        .updateTable('trade_legs')
        .set({ filled_qty: addQty })
        .where('trade_id', '=', seeded.tradeId)
        .where('leg_index', '=', 1)
        .execute()
      await sql`UPDATE positions SET size = size + ${addQty}::numeric WHERE channel_id = ${CH2_ID} AND symbol = 'BTCUSDT'`.execute(db)
      return seeded
    }

    async function tpOrders(tradeId: string) {
      return db
        .selectFrom('orders')
        .selectAll()
        .where('trade_id', '=', tradeId)
        .where('purpose', '=', 'tp')
        .where('status', '=', 'submitted')
        .orderBy('price', 'asc')
        .execute()
    }

    it('цель size_marker=one_unit -> reduce-only лимитка ровно на объём доливки', async () => {
      const { tradeId } = await seedWithAdd('3', '3')
      mock.queue.push(
        toolUseResponse(
          baseOutput({
            message_type: 'modify_tp',
            confidence: 0.9,
            actions: [{ type: 'modify_tp', symbol: 'BTCUSDT', side: 'long', evidence_source: 'text',
                        take_profits: [{ value: 61000, size_marker: 'one_unit' }, { value: 62000, index: 1 }] }],
          }),
        ),
      )

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'На 61000 скину доливку, первый таргет 62000' }), deps)

      const tps = await tpOrders(tradeId)
      expect(tps).toHaveLength(2)
      // Доливка выходит целиком на своей цене...
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('3')
      expect(new Decimal(tps[0]!.price ?? '0').toString()).toBe('61000')
      // ...а ступень лесенки делит ТО, ЧТО ОСТАЁТСЯ (6 − 3 = 3), треть от этого = 1.
      expect(new Decimal(tps[1]!.qty ?? '0').toString()).toBe('1')
      expect(new Decimal(tps[1]!.price ?? '0').toString()).toBe('62000')
    })

    it('без доливок цель one_unit пропускается (объём выдумывать нельзя), обычная ступень остаётся', async () => {
      await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
      await seedInstrument(db, 'BTCUSDT')
      const { tradeId } = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: '3' })
      mock.queue.push(
        toolUseResponse(
          baseOutput({
            message_type: 'modify_tp',
            confidence: 0.9,
            actions: [{ type: 'modify_tp', symbol: 'BTCUSDT', side: 'long', evidence_source: 'text',
                        take_profits: [{ value: 61000, size_marker: 'one_unit' }, { value: 62000, index: 1 }] }],
          }),
        ),
      )

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'На 61000 скину доливку, первый таргет 62000' }), deps)

      const tps = await tpOrders(tradeId)
      expect(tps).toHaveLength(1)
      expect(new Decimal(tps[0]!.price ?? '0').toString()).toBe('62000')
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('1') // треть от 3
    })

    it('после доливки «первая цель» считается от ПОЛНОГО объёма, а не от первого входа', async () => {
      const { tradeId } = await seedWithAdd('3', '3')
      mock.queue.push(
        toolUseResponse(
          baseOutput({
            message_type: 'modify_tp',
            confidence: 0.9,
            actions: [{ type: 'modify_tp', symbol: 'BTCUSDT', side: 'long', evidence_source: 'text',
                        take_profits: [{ value: 62000, index: 1 }] }],
          }),
        ),
      )

      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Первый таргет 62000' }), deps)

      const tps = await tpOrders(tradeId)
      expect(new Decimal(tps[0]!.qty ?? '0').toString()).toBe('2') // треть от 6, а не от 3
    })
  })

  describe('добор пересчитывает TP-лесенку под новый объём', () => {
    async function seedWithLadder(qty: string) {
      await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
      await seedInstrument(db, 'BTCUSDT')
      const seeded = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty })
      // Лесенка из трёх целей на ВЕСЬ объём — то, что ставит вход по структурному сигналу.
      mock.queue.push(
        toolUseResponse(
          baseOutput({
            message_type: 'modify_tp',
            confidence: 0.9,
            actions: [{ type: 'modify_tp', symbol: 'BTCUSDT', side: 'long',
                        take_profits: [{ value: 62000 }, { value: 63000 }, { value: 64000 }], evidence_source: 'text' }],
          }),
        ),
      )
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Следующие цели 62000, 63000, 64000' }), deps)
      return seeded
    }

    async function liveTps(tradeId: string) {
      return db
        .selectFrom('orders')
        .selectAll()
        .where('trade_id', '=', tradeId)
        .where('purpose', '=', 'tp')
        .where('status', '=', 'submitted')
        .orderBy('price', 'asc')
        .execute()
    }

    function addResponse(price?: number) {
      return toolUseResponse(
        baseOutput({
          message_type: 'add_to_position',
          confidence: 0.9,
          actions: [{ type: 'add', symbol: 'BTCUSDT', side: 'long', evidence_source: 'text',
                      ...(price !== undefined ? { entry: { mode: 'price' as const, price }, order_type: 'limit' as const } : {}) }],
        }),
      )
    }

    it('рыночный добор -> цели пересчитаны пропорционально, цены прежние', async () => {
      const { tradeId } = await seedWithLadder('3')
      const before = await liveTps(tradeId)
      expect(before.map((o) => new Decimal(o.qty ?? '0').toString())).toEqual(['1', '1', '1'])

      mock.queue.push(addResponse())
      // deps с ценой: рыночный добор без getMarkPrice уходит в skip(mark_price_unavailable).
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Добираю битка с текущих' }), {
        ...deps,
        getMarkPrice: async () => '60000',
      })

      const addOrder = await db
        .selectFrom('orders').selectAll().where('trade_id', '=', tradeId).where('purpose', '=', 'add')
        .executeTakeFirstOrThrow()
      const added = new Decimal(addOrder.qty ?? '0')
      expect(added.gt(0)).toBe(true)

      const after = await liveTps(tradeId)
      expect(after).toHaveLength(3)
      // Цены не изменились — доливка не переписывает цели автора, только их объём.
      expect(after.map((o) => new Decimal(o.price ?? '0').toString())).toEqual(['62000', '63000', '64000'])
      // Каждая ступень выросла в той же пропорции, что и позиция: было 1 из 3, стало (3+added)/3.
      const expectedShare = new Decimal(3).plus(added).div(3).toDecimalPlaces(2, Decimal.ROUND_DOWN)
      for (const tp of after) {
        expect(new Decimal(tp.qty ?? '0').toString()).toBe(expectedShare.toString())
      }
      // Суммарно лесенка снова покрывает всю позицию (с точностью до шага объёма).
      const covered = after.reduce((sum, o) => sum.plus(o.qty ?? '0'), new Decimal(0))
      expect(covered.minus(new Decimal(3).plus(added)).abs().lte('0.03')).toBe(true)
    })

    it('целей не было -> добор их не выдумывает', async () => {
      await seedChannel(db, { id: CH2_ID, ord: CH2_ORD, adapterId: 'ch2-freeform' })
      await seedInstrument(db, 'BTCUSDT')
      const { tradeId } = await seedOpenPosition(db, { channelId: CH2_ID, channelOrd: CH2_ORD, symbol: 'BTCUSDT', side: 'long', entryPrice: '60000', qty: '3' })

      mock.queue.push(addResponse())
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Добираю битка с текущих' }), {
        ...deps,
        getMarkPrice: async () => '60000',
      })

      expect(await liveTps(tradeId)).toHaveLength(0)
    })

    it('ЛИМИТНЫЙ добор -> лесенка не трогается: позиция ещё не выросла', async () => {
      const { tradeId } = await seedWithLadder('3')

      mock.queue.push(addResponse(58000))
      await processMessage(db, await insertMessage(db, { channelId: CH2_ID, text: 'Добираю битка от 58000' }), {
        ...deps,
        getMarkPrice: async () => '60000',
      })

      const after = await liveTps(tradeId)
      expect(after.map((o) => new Decimal(o.qty ?? '0').toString())).toEqual(['1', '1', '1'])
    })
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

// Important #2 адверсариального ревью (p2-final-fix-report.md): гейт живых AI-тестов ТОЛЬКО на
// "прокси доступен" означал, что обычный `pnpm test` молча жжёт платный ai-proxy (локальный
// прокси почти всегда поднят docker compose). Явный opt-in: AI_LIVE_TESTS=1. Без флага —
// describe.skip с понятным сообщением. Мок-based describe выше ('pipeline — AI-ветка (мок
// ai-proxy)') сюда НЕ относится — он никогда не ходит в живой ai-proxy (свой http-мок сервер),
// гейтить его флагом не нужно.
const AI_LIVE_TESTS = process.env.AI_LIVE_TESTS === '1'
if (!AI_LIVE_TESTS) {
  console.warn('[pipeline-ai.e2e.test] живой e2e-тест пропущен; задайте AI_LIVE_TESTS=1 для запуска (жжёт платный ai-proxy)')
}
const describeLive = AI_LIVE_TESTS ? describe : describe.skip

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

describeLive('pipeline — e2e живой ai-proxy (реальные форум-сообщения CH2) — требует AI_LIVE_TESTS=1', () => {
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
