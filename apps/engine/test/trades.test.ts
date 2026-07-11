import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { acquireSymbol, releaseSymbol, openTrade, addLeg, closeTrade, computeIsWin } from '../src/state/trades.js'

let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  // Идемпотентные прогоны против одной и той же copytrade_test (как repository.test.ts в tg-ingest).
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES
      (1, 1, 'ch1', 'channel', 'ch1'),
      (2, 2, 'ch2', 'channel', 'ch2')
  `.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

describe('openTrade', () => {
  it('human_ref = TR-<seq>, оба поля согласованы (один вызов nextval)', async () => {
    const result = await openTrade(db, { channelId: 1, symbol: 'SOLUSDT', side: 'long' })
    expect(result.humanRef).toBe(`TR-${result.seq}`)
    expect(result.tradeId).toBeTruthy()

    // и в самой строке БД то же самое согласование (не только в возвращаемом значении JS)
    const row = await db
      .selectFrom('trades')
      .select(['human_ref', 'seq', 'status'])
      .where('id', '=', result.tradeId)
      .executeTakeFirstOrThrow()
    expect(row.human_ref).toBe(`TR-${row.seq}`)
    expect(row.status).toBe('pending') // дефолт до первого филла (research: pending->open по факту с биржи)
  })

  it('два последовательных вызова -> монотонно растущие seq', async () => {
    const first = await openTrade(db, { channelId: 1, symbol: 'BTCUSDT', side: 'long' })
    const second = await openTrade(db, { channelId: 1, symbol: 'ETHUSDT', side: 'short' })
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(second.humanRef).toBe(`TR-${second.seq}`)
  })
})

describe('acquireSymbol / releaseSymbol', () => {
  it('первый захват -> true, повторный тем же (channel, symbol) -> false, после release -> снова true', async () => {
    const trade = await openTrade(db, { channelId: 1, symbol: 'ADAUSDT', side: 'long' })

    const first = await acquireSymbol(db, { channelId: 1, symbol: 'ADAUSDT', tradeId: trade.tradeId })
    expect(first).toBe(true)

    const second = await acquireSymbol(db, { channelId: 1, symbol: 'ADAUSDT', tradeId: trade.tradeId })
    expect(second).toBe(false)

    await releaseSymbol(db, { channelId: 1, symbol: 'ADAUSDT' })

    const third = await acquireSymbol(db, { channelId: 1, symbol: 'ADAUSDT', tradeId: trade.tradeId })
    expect(third).toBe(true)
  })

  it('разные каналы держат один и тот же символ независимо (субаккаунт на канал)', async () => {
    const tradeCh1 = await openTrade(db, { channelId: 1, symbol: 'XRPUSDT', side: 'long' })
    const tradeCh2 = await openTrade(db, { channelId: 2, symbol: 'XRPUSDT', side: 'short' })

    expect(await acquireSymbol(db, { channelId: 1, symbol: 'XRPUSDT', tradeId: tradeCh1.tradeId })).toBe(true)
    expect(await acquireSymbol(db, { channelId: 2, symbol: 'XRPUSDT', tradeId: tradeCh2.tradeId })).toBe(true)
    // внутри канала 1 символ всё ещё занят
    expect(await acquireSymbol(db, { channelId: 1, symbol: 'XRPUSDT', tradeId: tradeCh1.tradeId })).toBe(false)
  })
})

describe('addLeg', () => {
  it('создаёт строку trade_legs с запрошенным qty', async () => {
    const trade = await openTrade(db, { channelId: 1, symbol: 'DOGEUSDT', side: 'long' })
    const leg = await addLeg(db, {
      tradeId: trade.tradeId,
      legIndex: 0,
      kind: 'entry',
      requestedQty: '1500',
    })
    expect(leg.legId).toBeTruthy()

    const row = await db
      .selectFrom('trade_legs')
      .select(['leg_index', 'kind', 'requested_qty', 'status'])
      .where('id', '=', leg.legId)
      .executeTakeFirstOrThrow()
    expect(row.leg_index).toBe(0)
    expect(row.kind).toBe('entry')
    expect(row.requested_qty).toBe('1500.0000000000') // NUMERIC(30,10) — строка
    expect(row.status).toBe('pending')
  })

  it('идемпотентен: повтор с теми же (tradeId, legIndex) не плодит вторую строку и возвращает тот же legId', async () => {
    const trade = await openTrade(db, { channelId: 1, symbol: 'LINKUSDT', side: 'short' })
    const first = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '10' })
    const second = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '10' })
    expect(second.legId).toBe(first.legId)

    const count = await db
      .selectFrom('trade_legs')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('trade_id', '=', trade.tradeId)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)
  })

  it('TP-лесенка — разные leg_index для разных целей одной сделки', async () => {
    const trade = await openTrade(db, { channelId: 1, symbol: 'AVAXUSDT', side: 'long' })
    await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '300' })
    const tp1 = await addLeg(db, { tradeId: trade.tradeId, legIndex: 1, kind: 'add', requestedQty: '100' })
    const tp2 = await addLeg(db, { tradeId: trade.tradeId, legIndex: 2, kind: 'add', requestedQty: '100' })
    expect(tp1.legId).not.toBe(tp2.legId)
  })
})

describe('closeTrade', () => {
  it('переводит trade в closed и освобождает symbol_ownership (символ снова захватываем)', async () => {
    const trade = await openTrade(db, { channelId: 1, symbol: 'LTCUSDT', side: 'long' })
    await acquireSymbol(db, { channelId: 1, symbol: 'LTCUSDT', tradeId: trade.tradeId })

    await closeTrade(db, { tradeId: trade.tradeId })

    const row = await db
      .selectFrom('trades')
      .select(['status', 'closed_at'])
      .where('id', '=', trade.tradeId)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('closed')
    expect(row.closed_at).not.toBeNull()

    // символ освобождён -> другая сделка того же канала может его захватить
    const other = await openTrade(db, { channelId: 1, symbol: 'LTCUSDT', side: 'short' })
    expect(await acquireSymbol(db, { channelId: 1, symbol: 'LTCUSDT', tradeId: other.tradeId })).toBe(true)
  })

  // Win Rate (Ф4, task-2-brief.md): is_win проставляется при закрытии. Канал 2 использован ниже
  // (не 1) — изолирует эти тесты от остальных сделок канала 1 в этом файле, чтобы проверка
  // 'channel.stats' (агрегирует ВСЕ закрытые сделки канала) не зависела от порядка тестов.
  it('realizedPnl передан положительным -> is_win = true', async () => {
    const trade = await openTrade(db, { channelId: 2, symbol: 'WINUSDT', side: 'long' })
    await closeTrade(db, { tradeId: trade.tradeId, realizedPnl: '42.50' })
    const row = await db.selectFrom('trades').select('is_win').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()
    expect(row.is_win).toBe(true)
  })

  it('realizedPnl отрицателен ИЛИ ровно ноль -> is_win = false (ноль — не выигрыш)', async () => {
    const lossTrade = await openTrade(db, { channelId: 2, symbol: 'LOSSUSDT', side: 'long' })
    await closeTrade(db, { tradeId: lossTrade.tradeId, realizedPnl: '-10' })
    const lossRow = await db.selectFrom('trades').select('is_win').where('id', '=', lossTrade.tradeId).executeTakeFirstOrThrow()
    expect(lossRow.is_win).toBe(false)

    const zeroTrade = await openTrade(db, { channelId: 2, symbol: 'ZEROUSDT', side: 'long' })
    await closeTrade(db, { tradeId: zeroTrade.tradeId, realizedPnl: '0' })
    const zeroRow = await db.selectFrom('trades').select('is_win').where('id', '=', zeroTrade.tradeId).executeTakeFirstOrThrow()
    expect(zeroRow.is_win).toBe(false)
  })

  it('realizedPnl НЕ передан в этом вызове -> is_win выводится из уже посчитанного значения колонки (private-ws.ts-путь)', async () => {
    const trade = await openTrade(db, { channelId: 2, symbol: 'PRECALCUSDT', side: 'long' })
    // Симулирует то, что recalcTradeRealizedPnl (private-ws.ts) уже посчитал realized_pnl ДО
    // прихода финального position-пуша size=0, который вызывает closeTrade без realizedPnl.
    await db.updateTable('trades').set({ realized_pnl: '15' }).where('id', '=', trade.tradeId).execute()

    await closeTrade(db, { tradeId: trade.tradeId })

    const row = await db.selectFrom('trades').select(['is_win', 'realized_pnl']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow()
    expect(row.is_win).toBe(true)
    expect(row.realized_pnl).toBe('15.0000000000')
  })

  it("status='cancelled' -> is_win остаётся null (неисполнившаяся лимитка — не результат)", async () => {
    const trade = await openTrade(db, { channelId: 2, symbol: 'CANCELUSDT', side: 'long' })
    await closeTrade(db, { tradeId: trade.tradeId, status: 'cancelled', realizedPnl: '99' })
    const row = await db.selectFrom('trades').select(['status', 'is_win']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow()
    expect(row.status).toBe('cancelled')
    expect(row.is_win).toBeNull()
  })

  it('явный params.isWin приоритетнее автоматического вывода из realized_pnl', async () => {
    const trade = await openTrade(db, { channelId: 2, symbol: 'OVERRIDEUSDT', side: 'long' })
    await closeTrade(db, { tradeId: trade.tradeId, realizedPnl: '50', isWin: false })
    const row = await db.selectFrom('trades').select('is_win').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()
    expect(row.is_win).toBe(false)
  })

  it("закрытие ('closed') публикует 'channel.stats' с пересчитанным winRate канала в domain_events", async () => {
    const winTrade = await openTrade(db, { channelId: 2, symbol: 'EVENTAUSDT', side: 'long' })
    await closeTrade(db, { tradeId: winTrade.tradeId, realizedPnl: '10' })

    const events = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'channel.stats')
      .where('aggregate_id', '=', '2')
      .orderBy('id', 'desc')
      .execute()
    expect(events.length).toBeGreaterThan(0)
    const payload = events[0]!.payload as { channelId: number; winRate: string }
    expect(payload.channelId).toBe(2)
    // Канал 2 копит закрытые сделки через весь этот describe (не '—', раз closedTrades>0) —
    // точный % не бьём (зависит от порядка/числа предыдущих тестов), проверяем только форму.
    expect(payload.winRate).toMatch(/^\d+%$/)
  })

  it("status='cancelled' -> 'channel.stats' НЕ публикуется (cancelled не результат)", async () => {
    const trade = await openTrade(db, { channelId: 2, symbol: 'NOEVENTUSDT', side: 'long' })
    const before = await db
      .selectFrom('domain_events')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('type', '=', 'channel.stats')
      .executeTakeFirstOrThrow()

    await closeTrade(db, { tradeId: trade.tradeId, status: 'cancelled' })

    const after = await db
      .selectFrom('domain_events')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('type', '=', 'channel.stats')
      .executeTakeFirstOrThrow()
    expect(Number(after.n)).toBe(Number(before.n))
  })
})

describe('computeIsWin', () => {
  it('положительный realized_pnl -> true', () => {
    expect(computeIsWin('42.5')).toBe(true)
  })

  it('отрицательный realized_pnl -> false', () => {
    expect(computeIsWin('-1')).toBe(false)
  })

  it('ровно ноль -> false (ноль — не выигрыш, строго ">")', () => {
    expect(computeIsWin('0')).toBe(false)
    expect(computeIsWin('0.0000000000')).toBe(false)
  })
})
