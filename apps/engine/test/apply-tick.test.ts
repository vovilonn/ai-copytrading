import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { applyMarkPriceTick, openPositionSymbols } from '../src/market-data/apply-tick.js'

/**
 * Интеграционный тест "тика" tickers (task-10-brief.md): имитирует WS-сообщение уже разобранным
 * (parseMarkPriceTick покрыт отдельно в ticker-message.test.ts) — applyMarkPriceTick(db, symbol,
 * markPrice) должен обновить positions.mark_price/unrealised_pnl по формуле long/short (Decimal,
 * см. pnl.test.ts) И опубликовать position.upsert в domain_events, для КАЖДОГО канала, который
 * держит этот символ (решение #1 "субаккаунт на канал" — один symbol может быть открыт у
 * нескольких каналов одновременно, PK positions это (channel_id, symbol)).
 */

let db: Kysely<DB>

const CHANNEL_LONG = 1 // держит BTCUSDT long
const CHANNEL_SHORT = 2 // держит BTCUSDT short (другой канал, тот же символ)

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES
      (${CHANNEL_LONG}, 1, 'ch-long', 'channel', 'ch1'),
      (${CHANNEL_SHORT}, 2, 'ch-short', 'channel', 'ch1')
  `.execute(db)
})

async function seedPosition(
  channelId: number,
  symbol: string,
  side: 'long' | 'short',
  size: string,
  avgPrice: string,
): Promise<void> {
  await db
    .insertInto('positions')
    .values({
      channel_id: channelId,
      symbol,
      trade_id: null,
      side,
      size,
      avg_price: avgPrice,
      mark_price: avgPrice,
      leverage: '5',
    })
    .execute()
}

describe('openPositionSymbols', () => {
  it('возвращает DISTINCT символы с size<>0, пропускает закрытые (size=0)', async () => {
    await seedPosition(CHANNEL_LONG, 'BTCUSDT', 'long', '0.42', '62400')
    await seedPosition(CHANNEL_SHORT, 'SOLUSDT', 'short', '0', '148.0') // закрыта — не должна попасть в подписку

    const symbols = await openPositionSymbols(db)
    expect(symbols).toEqual(['BTCUSDT'])
  })
})

describe('applyMarkPriceTick', () => {
  it('long: mark_price и unrealised_pnl обновляются по формуле (mark-avg)*size, публикуется position.upsert', async () => {
    await seedPosition(CHANNEL_LONG, 'BTCUSDT', 'long', '0.42', '62400')

    const notifyNeeded = await applyMarkPriceTick(db, 'BTCUSDT', '63180')
    expect(notifyNeeded).toBe(true)

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_LONG)
      .where('symbol', '=', 'BTCUSDT')
      .executeTakeFirstOrThrow()
    expect(row.mark_price).toBe('63180.0000000000')
    // (63180-62400)*0.42 = 327.6
    expect(Number(row.unrealised_pnl)).toBeCloseTo(327.6, 6)

    const event = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'position.upsert')
      .where('aggregate_id', '=', `${CHANNEL_LONG}:BTCUSDT`)
      .executeTakeFirstOrThrow()
    const payload = event.payload as { channelId: number; symbol: string; markPrice: string }
    expect(payload.channelId).toBe(CHANNEL_LONG)
    expect(payload.symbol).toBe('BTCUSDT')
    expect(payload.markPrice).toBe('63180.0000000000')
  })

  it('short: unrealised_pnl = (avg-mark)*size — прибыль при падении цены', async () => {
    await seedPosition(CHANNEL_SHORT, 'BTCUSDT', 'short', '120', '148.0')

    await applyMarkPriceTick(db, 'BTCUSDT', '143.2')

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_SHORT)
      .where('symbol', '=', 'BTCUSDT')
      .executeTakeFirstOrThrow()
    // (148.0-143.2)*120 = 576
    expect(Number(row.unrealised_pnl)).toBeCloseTo(576, 6)
  })

  it('один тик обновляет ОБЕ строки (разные каналы, один символ) независимо своей стороной', async () => {
    // Решение #1 "субаккаунт на канал": PK positions — (channel_id, symbol), поэтому два разных
    // канала МОГУТ одновременно держать один и тот же символ — applyMarkPriceTick обязан обойти
    // ВСЕ такие строки на один тик, а не только первую найденную.
    await seedPosition(CHANNEL_LONG, 'BTCUSDT', 'long', '0.42', '62400')
    await seedPosition(CHANNEL_SHORT, 'BTCUSDT', 'short', '120', '148.0')

    const notifyNeeded = await applyMarkPriceTick(db, 'BTCUSDT', '65000')
    expect(notifyNeeded).toBe(true)

    const rows = await db.selectFrom('positions').selectAll().where('symbol', '=', 'BTCUSDT').execute()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.mark_price).toBe('65000.0000000000')
    }
    const longRow = rows.find((r) => r.channel_id === CHANNEL_LONG)!
    const shortRow = rows.find((r) => r.channel_id === CHANNEL_SHORT)!
    // long: (65000-62400)*0.42 = 1092
    expect(Number(longRow.unrealised_pnl)).toBeCloseTo(1092, 6)
    // short: (148.0-65000)*120 — глубоко отрицательный (mark ушёл далеко выше входа)
    expect(Number(shortRow.unrealised_pnl)).toBeLessThan(0)

    const events = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'position.upsert')
      .execute()
    expect(events).toHaveLength(2)
  })

  it('символ без открытых позиций (size=0 или нет строк) -> false, никаких domain_events', async () => {
    const notifyNeeded = await applyMarkPriceTick(db, 'NOSUCHUSDT', '1')
    expect(notifyNeeded).toBe(false)

    const events = await db.selectFrom('domain_events').selectAll().execute()
    expect(events).toHaveLength(0)
  })

  it('task-11 полировка Б: {emit:false} обновляет mark_price/unrealised_pnl, но НЕ публикует position.upsert', async () => {
    await seedPosition(CHANNEL_LONG, 'BTCUSDT', 'long', '0.42', '62400')

    const notifyNeeded = await applyMarkPriceTick(db, 'BTCUSDT', '63180', { emit: false })
    expect(notifyNeeded).toBe(false) // нет свежего domain_events -> звать pg_notify незачем

    const row = await db
      .selectFrom('positions')
      .selectAll()
      .where('channel_id', '=', CHANNEL_LONG)
      .where('symbol', '=', 'BTCUSDT')
      .executeTakeFirstOrThrow()
    // Запись в БД — как и с emit:true, троттлинг WS не должен ронять актуальность mark_price.
    expect(row.mark_price).toBe('63180.0000000000')
    expect(Number(row.unrealised_pnl)).toBeCloseTo(327.6, 6)

    const events = await db.selectFrom('domain_events').selectAll().where('type', '=', 'position.upsert').execute()
    expect(events).toHaveLength(0)
  })
})
