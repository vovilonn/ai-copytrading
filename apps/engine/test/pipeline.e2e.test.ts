import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { ParseContext } from 'shared/domain.js'
import { parseCh1 } from '../src/adapters/ch1.adapter.js'
import { resolveSymbol } from '../src/symbol-resolver.js'
import { createExecutionPort } from '../src/execution/port.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from '../src/pipeline.js'

/**
 * e2e-тест пайплайна (task-7-brief.md): весь дамп CH1 (100 реальных сообщений) через
 * normalize→parse→reconcile→risk→execute в тестовой БД. Проверяем итоговые trades/actions/
 * positions И идемпотентность повторного прогона (реальный сценарий рестарта engine —
 * backend-architecture.md §3: "сообщения в нетерминальных статусах переигрываются").
 */

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/ch1.jsonl', import.meta.url))
const CHANNEL_ID = 2088626562
const CHANNEL_ORD = 1
const NOT_LISTED_ON_TESTNET = new Set(['GRASSUSDT', 'EIGENUSDT']) // research §8 — status=Closed на testnet

interface FixtureMessage {
  id: number
  date: string
  text: string
  media: string | null
  mediaFile: string | null
  groupedId: string | null
  replyToMsgId: number | null
}

function loadFixture(): FixtureMessage[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureMessage)
}

/**
 * Разбирает всю фикстуру с ЗАВЕДОМО true isListed — единственная цель: собрать множество
 * символов, которые вообще встречаются в дампе, чтобы засеять для них instruments. Реальный
 * гейт листинга (GRASS/EIGEN исключены) применяется отдельно при вставке строк ниже — тем же
 * приёмом, что и ch1.adapter.test.ts (buildContext/alwaysListed).
 */
function discoverSymbols(messages: FixtureMessage[]): Set<string> {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const alwaysListed = () => true
  const buildCtx = (m: FixtureMessage): ParseContext => ({
    channelId: String(CHANNEL_ID),
    message: { id: m.id, text: m.text, date: m.date, replyToMsgId: m.replyToMsgId, groupedId: m.groupedId, media: m.media, mediaFile: m.mediaFile },
    resolveSymbol: (raw: string) => resolveSymbol(raw, alwaysListed),
    isListed: alwaysListed,
    getMessage: (id: number) => {
      const found = byId.get(id)
      if (!found) return null
      return { id: found.id, text: found.text, date: found.date, replyToMsgId: found.replyToMsgId, groupedId: found.groupedId, media: found.media, mediaFile: found.mediaFile }
    },
    openPositions: new Map(),
    lastTouchedSymbol: null,
  })

  const symbols = new Set<string>()
  for (const m of messages) {
    const result = parseCh1(buildCtx(m))
    for (const intent of result.intents) {
      if (intent.kind === 'entry_signal' || intent.kind === 'delta') {
        if (intent.symbol) symbols.add(intent.symbol)
      }
    }
  }
  return symbols
}

let db: Kysely<DB>
const fixture = loadFixture()
const deps: PipelineDeps = { executionPort: createExecutionPort('dry_run'), network: 'testnet', equity: '1000' }

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  const seedNow = new Date()
  await db
    .insertInto('channels')
    .values({
      id: CHANNEL_ID,
      ord: CHANNEL_ORD,
      key: 'ch-2088626562',
      source_kind: 'channel',
      topic_id: null,
      adapter_id: 'ch1-structured',
      title: null,
      handle: null,
      status: 'active',
      last_seen_message_id: 0,
      bybit_sub_uid: null,
      bybit_api_key_enc: null,
      bybit_api_secret_enc: null,
      created_at: seedNow,
      updated_at: seedNow,
    })
    .execute()

  await db
    .insertInto('channel_settings')
    .values({
      channel_id: CHANNEL_ID,
      enabled: true,
      trade_size: '500',
      max_leverage: '20',
      cross_margin: true,
      no_sl_policy: 'attach_protective_sl',
      no_sl_buffer_sec: 0,
      add_sizing_mode: 'trade_size',
      mirror_manual_fraction: false,
      limit_ttl_sec: 604_800,
      updated_at: new Date(),
    })
    .execute()

  // instruments: все символы дампа торгуются (status='Trading'), кроме GRASS/EIGEN (реальный
  // факт testnet, research §8: status=Closed) — единые дефолтные шаг/плечо/mmr для всех (не
  // точные метаданные Bybit по символу — это не предмет ЭТОГО теста, sizing/leverage со своими
  // числами уже покрыты property-тестами risk/*.test.ts).
  const symbols = discoverSymbols(fixture)
  const now = new Date()
  for (const symbol of symbols) {
    await db
      .insertInto('instruments')
      .values({
        symbol,
        network: 'testnet',
        base_coin: symbol.replace(/USDT$/, ''),
        status: NOT_LISTED_ON_TESTNET.has(symbol) ? 'Closed' : 'Trading',
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

  // 100 сообщений фикстуры как строки messages(status='received') — ровно то, что в БД оставил
  // бы tg-ingest после реального приёма (raw хранит исходный JSON дампа).
  for (const m of fixture) {
    await db
      .insertInto('messages')
      .values({
        channel_id: CHANNEL_ID,
        tg_message_id: m.id,
        reply_to_msg_id: m.replyToMsgId,
        grouped_id: m.groupedId,
        is_topic_message: false,
        text: m.text,
        has_media: m.media !== null,
        media_kind: m.media,
        msg_ts: new Date(m.date),
        raw: JSON.stringify(m),
        status: 'received',
      })
      .execute()
  }
})

afterAll(async () => {
  await db.destroy()
})

async function runPipelineOnce(): Promise<void> {
  const rows = await db
    .selectFrom('messages')
    .selectAll()
    .where('channel_id', '=', CHANNEL_ID)
    .orderBy('tg_message_id', 'asc')
    .execute()
  for (const row of rows) {
    const message: PipelineMessage = {
      id: row.id,
      channelId: row.channel_id,
      tgMessageId: row.tg_message_id,
      replyToMsgId: row.reply_to_msg_id,
      groupedId: row.grouped_id,
      text: row.text,
      mediaKind: row.media_kind,
      msgTs: row.msg_ts,
    }
    await processMessage(db, message, deps)
  }
}

async function messageIdFor(tgMessageId: number): Promise<string> {
  const row = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', CHANNEL_ID)
    .where('tg_message_id', '=', tgMessageId)
    .executeTakeFirstOrThrow()
  return row.id
}

describe('pipeline — первый прогон 100 сообщений CH1', () => {
  it('прогоняет фикстуру без исключений', async () => {
    await expect(runPipelineOnce()).resolves.toBeUndefined()
  })

  it('все 100 сообщений канала продвинуты из received в терминальный статус', async () => {
    const rows = await db.selectFrom('messages').select(['status']).where('channel_id', '=', CHANNEL_ID).execute()
    expect(rows).toHaveLength(100)
    for (const row of rows) {
      expect(row.status, `неожиданный статус ${row.status}`).not.toBe('received')
      expect(['noise', 'skipped', 'needs_review', 'executed']).toContain(row.status)
    }
  })

  it('созданы trades с human_ref TR-<seq>', async () => {
    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', CHANNEL_ID).execute()
    expect(trades.length).toBeGreaterThan(0)
    for (const t of trades) {
      expect(t.human_ref).toMatch(/^TR-\d+$/)
      expect(t.human_ref).toBe(`TR-${t.seq}`)
    }
    console.log(`[pipeline e2e] trades создано: ${trades.length}, примеры human_ref: ${trades.slice(0, 5).map((t) => t.human_ref).join(', ')}`)
  })

  it('созданы actions с trade_id для исполненных intent-ов', async () => {
    const actionsWithTrade = await db
      .selectFrom('actions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_ID)
      .where('trade_id', 'is not', null)
      .execute()
    expect(actionsWithTrade.length).toBeGreaterThan(0)

    const totalActions = await db.selectFrom('actions').select(({ fn }) => fn.countAll<string>().as('n')).where('channel_id', '=', CHANNEL_ID).executeTakeFirstOrThrow()
    console.log(`[pipeline e2e] actions всего: ${totalActions.n}, с trade_id: ${actionsWithTrade.length}`)
  })

  it('созданы positions для открытых сделок', async () => {
    const positions = await db.selectFrom('positions').selectAll().where('channel_id', '=', CHANNEL_ID).execute()
    expect(positions.length).toBeGreaterThan(0)
    console.log(`[pipeline e2e] positions создано: ${positions.length}`)
  })

  it('GRASSUSDT (msg 2868) → action skip reason symbol_not_listed', async () => {
    const messageId = await messageIdFor(2868)
    const action = await db.selectFrom('actions').selectAll().where('message_id', '=', messageId).where('action_index', '=', 0).executeTakeFirstOrThrow()
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('symbol_not_listed')
  })

  it('EIGENUSDT (msg 2871) → action skip reason symbol_not_listed', async () => {
    const messageId = await messageIdFor(2871)
    const action = await db.selectFrom('actions').selectAll().where('message_id', '=', messageId).where('action_index', '=', 0).executeTakeFirstOrThrow()
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('symbol_not_listed')
  })

  it('дельта 2797 (reply на сигнал 2796, "первая цель есть") матчится к открытой LIT-позиции', async () => {
    const entryMessageId = await messageIdFor(2796)
    const entryAction = await db.selectFrom('actions').selectAll().where('message_id', '=', entryMessageId).where('action_index', '=', 0).executeTakeFirstOrThrow()
    expect(entryAction.status).toBe('executed')
    expect(entryAction.trade_id).not.toBeNull()

    const deltaMessageId = await messageIdFor(2797)
    const deltaAction = await db.selectFrom('actions').selectAll().where('message_id', '=', deltaMessageId).where('action_index', '=', 0).executeTakeFirstOrThrow()
    expect(deltaAction.status).toBe('executed')
    expect(deltaAction.symbol).toBe('LITUSDT')
    // Дельта матчится к ТОЙ ЖЕ сделке, что открыл сигнал 2796 (символ резолвит позицию, R3).
    expect(deltaAction.trade_id).toBe(entryAction.trade_id)
  })

  it('publикует domain_events (action.new/action.skipped/position.upsert)', async () => {
    const types = await db.selectFrom('domain_events').select('type').execute()
    const typeSet = new Set(types.map((t) => t.type))
    expect(typeSet.has('action.new')).toBe(true)
    expect(typeSet.has('action.skipped')).toBe(true)
    expect(typeSet.has('position.upsert')).toBe(true)
  })
})

describe('pipeline — идемпотентность повторного прогона', () => {
  let tradesBefore = 0
  let positionsBefore = 0

  it('второй прогон после сброса messages.status в received не создаёт дублей', async () => {
    tradesBefore = Number(
      (await db.selectFrom('trades').select(({ fn }) => fn.countAll<string>().as('n')).where('channel_id', '=', CHANNEL_ID).executeTakeFirstOrThrow()).n,
    )
    positionsBefore = Number(
      (await db.selectFrom('positions').select(({ fn }) => fn.countAll<string>().as('n')).where('channel_id', '=', CHANNEL_ID).executeTakeFirstOrThrow()).n,
    )

    await db.updateTable('messages').set({ status: 'received' }).where('channel_id', '=', CHANNEL_ID).execute()
    await runPipelineOnce()

    const dupActions = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM (
        SELECT message_id, action_index FROM actions GROUP BY 1, 2 HAVING count(*) > 1
      ) d
    `.execute(db)
    expect(Number(dupActions.rows[0]?.n)).toBe(0)

    const dupOrders = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM (
        SELECT order_link_id FROM orders GROUP BY 1 HAVING count(*) > 1
      ) d
    `.execute(db)
    expect(Number(dupOrders.rows[0]?.n)).toBe(0)

    const tradesAfter = Number(
      (await db.selectFrom('trades').select(({ fn }) => fn.countAll<string>().as('n')).where('channel_id', '=', CHANNEL_ID).executeTakeFirstOrThrow()).n,
    )
    const positionsAfter = Number(
      (await db.selectFrom('positions').select(({ fn }) => fn.countAll<string>().as('n')).where('channel_id', '=', CHANNEL_ID).executeTakeFirstOrThrow()).n,
    )
    expect(tradesAfter).toBe(tradesBefore)
    expect(positionsAfter).toBe(positionsBefore)
    console.log(`[pipeline e2e] идемпотентность: trades ${tradesBefore}->${tradesAfter}, positions ${positionsBefore}->${positionsAfter}, 0 дублей actions/orders`)
  })
})
