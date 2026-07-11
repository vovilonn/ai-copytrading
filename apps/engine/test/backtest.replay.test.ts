import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Network } from 'shared/domain.js'
import { KlineSource, type Candle, type KlineOracle } from '../src/backtest/kline-source.js'
import { replay, simulateOutcome, type BacktestReport } from '../src/backtest/replay.js'

const CHANNEL_ID = 2088626562
const NETWORK: Network = 'testnet'

// ---------------------------------------------------------------------------
// Юнит: simulateOutcome (чистая функция — точные числа, без сети/БД)
// ---------------------------------------------------------------------------

function candle(start: number, high: string, low: string, close: string): Candle {
  return { start, open: close, high, low, close }
}

describe('simulateOutcome', () => {
  it('long: вся лесенка TP взята в одной свече', () => {
    const res = simulateOutcome({
      side: 'long',
      entry: '100',
      totalQty: '3',
      sl: '90',
      tps: [
        { price: '110', qty: '1' },
        { price: '120', qty: '1' },
        { price: '130', qty: '1' },
      ],
      candles: [candle(0, '135', '99', '132')],
    })
    expect(res.exit).toBe('tp')
    expect(res.filledQty).toBe('3')
    expect(res.pnl).toBe('60') // 10 + 20 + 30
  })

  it('long: SL выбивает весь остаток', () => {
    const res = simulateOutcome({
      side: 'long',
      entry: '100',
      totalQty: '2',
      sl: '90',
      tps: [{ price: '120', qty: '2' }],
      candles: [candle(0, '105', '85', '88')],
    })
    expect(res.exit).toBe('sl')
    expect(res.pnl).toBe('-20') // (90-100)*2
  })

  it('short: TP взяты вниз', () => {
    const res = simulateOutcome({
      side: 'short',
      entry: '100',
      totalQty: '2',
      sl: '110',
      tps: [
        { price: '90', qty: '1' },
        { price: '80', qty: '1' },
      ],
      candles: [candle(0, '101', '78', '79')],
    })
    expect(res.exit).toBe('tp')
    expect(res.pnl).toBe('30') // (100-90) + (100-80)
  })

  it('mark-to-market: ни TP ни SL не задет — закрытие по close', () => {
    const res = simulateOutcome({
      side: 'long',
      entry: '100',
      totalQty: '1',
      sl: '80',
      tps: [{ price: '130', qty: '1' }],
      candles: [candle(0, '105', '95', '102')],
    })
    expect(res.exit).toBe('mtm')
    expect(res.pnl).toBe('2') // (102-100)*1
  })

  it('нет свечей — исход none, PnL 0', () => {
    const res = simulateOutcome({ side: 'long', entry: '100', totalQty: '1', sl: '90', tps: [], candles: [] })
    expect(res.exit).toBe('none')
    expect(res.pnl).toBe('0')
    expect(res.lastPrice).toBeNull()
  })

  it('внутрисвечная неоднозначность (SL и TP в одной свече) — консервативно в пользу SL', () => {
    const res = simulateOutcome({
      side: 'long',
      entry: '100',
      totalQty: '1',
      sl: '95',
      tps: [{ price: '105', qty: '1' }],
      candles: [candle(0, '106', '94', '100')], // задеты и TP(105), и SL(95)
    })
    expect(res.exit).toBe('sl')
    expect(res.pnl).toBe('-5')
  })
})

// ---------------------------------------------------------------------------
// Юнит: KlineSource.klineAt (мок fetch — без реальной сети)
// ---------------------------------------------------------------------------

interface FakeRes {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}
function okJson(body: unknown): FakeRes {
  return { ok: true, status: 200, json: async () => body, text: async () => '' }
}

describe('KlineSource.klineAt', () => {
  it('округляет tMs вниз до минуты и возвращает close нужной свечи; кэш не долбит дважды', async () => {
    const urls: string[] = []
    const minute = 1_700_000_040_000 // кратно 60000
    const fetchFn = async (url: string): Promise<FakeRes> => {
      urls.push(url)
      return okJson({ retCode: 0, retMsg: 'OK', result: { list: [[String(minute), '2.0', '3.0', '1.0', '2.5', '0', '0']] } })
    }
    const src = new KlineSource({ fetchFn, sleepFn: async () => {}, minIntervalMs: 0 })

    const tMs = minute + 45_123 // середина минуты
    expect(await src.klineAt('BTCUSDT', tMs)).toBe('2.5')
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(`start=${minute}`)
    expect(urls[0]).toContain(`end=${minute + 60_000}`)

    // второй вызов той же минуты — из кэша, без нового fetch
    expect(await src.klineAt('BTCUSDT', minute)).toBe('2.5')
    expect(urls).toHaveLength(1)
  })

  it('пустой list -> null, и null кэшируется (нет повторного запроса)', async () => {
    let calls = 0
    const fetchFn = async (): Promise<FakeRes> => {
      calls++
      return okJson({ retCode: 0, retMsg: 'OK', result: { list: [] } })
    }
    const src = new KlineSource({ fetchFn, sleepFn: async () => {}, minIntervalMs: 0 })
    expect(await src.klineAt('DEADUSDT', 1_700_000_000_000)).toBeNull()
    expect(await src.klineAt('DEADUSDT', 1_700_000_000_000)).toBeNull()
    expect(calls).toBe(1)
  })

  it('getCandles сортирует по времени и дедуплицирует', async () => {
    const fetchFn = async (): Promise<FakeRes> =>
      okJson({
        retCode: 0,
        result: {
          // Bybit отдаёт УБЫВАЮЩЕ; ждём восходящую после нормализации
          list: [
            ['900000', '2', '2', '2', '2', '0', '0'],
            ['0', '1', '1', '1', '1', '0', '0'],
          ],
        },
      })
    const src = new KlineSource({ fetchFn, sleepFn: async () => {}, minIntervalMs: 0 })
    const candles = await src.getCandles('BTCUSDT', 0, 1_800_000, '15')
    expect(candles.map((c) => c.start)).toEqual([0, 900_000])
  })
})

// ---------------------------------------------------------------------------
// Мок-оракул цен для реплея (детерминированный, без сети)
// ---------------------------------------------------------------------------

class MockKline implements KlineOracle {
  readonly stats = { requests: 0, cacheHits: 0, cachedKeys: 0 }
  async klineAt(symbol: string): Promise<string | null> {
    if (symbol === 'LITUSDT') return '1.50' // ~= сигнальный mid 1.5004 -> проходит slippage-гейт
    if (symbol === 'SOLUSDT') return '90' // далеко от mid 105 -> price_slippage
    return null
  }
  async getCandles(symbol: string): Promise<Candle[]> {
    if (symbol === 'LITUSDT') {
      // short 1.5004: цена идёт вниз, берёт все TP (1.4428/1.3926/1.2777), SL 1.7137 не задет
      return [candle(0, '1.51', '1.30', '1.31'), candle(900_000, '1.32', '1.25', '1.26')]
    }
    return []
  }
}

// ---------------------------------------------------------------------------
// Интеграция: реплей на фикстуре в изолированной схеме
// ---------------------------------------------------------------------------

let db: Kysely<DB>

interface Fx {
  id: number
  reply: number | null
  text: string
}
const FIXTURE: Fx[] = [
  { id: 1000, reply: null, text: '#LIT/USDT 📉 SHORT\n\nДиапазон входа: 1.5273-1.4735$\nTP: 1.4428$ - 1.3926$ - 1.2777$\nSL: 1.7137$\n\nРиск: 2%' },
  { id: 1001, reply: 1000, text: '#LIT - первая цель есть, зафиксировал 50% позиции' },
  { id: 1002, reply: null, text: '#AAA/USDT LONG\n\nДиапазон входа: 10-11$\nTP: 12$' }, // no_SL
  { id: 1003, reply: null, text: '#PEPE/USDT LONG\n\nДиапазон входа: 0.0000100-0.0000110$\nTP: 0.0000120$\nSL: 0.0000090$' }, // symbol_not_listed
  { id: 1004, reply: null, text: 'Анонс большого созвона в Zoom сегодня' }, // noise
  { id: 1005, reply: null, text: '#SOL/USDT LONG\n\nДиапазон входа: 100-110$\nTP: 120$\nSL: 90$' }, // price_slippage
]

async function seedPublic(): Promise<void> {
  const now = new Date()
  await db
    .insertInto('channels')
    .values({
      id: CHANNEL_ID,
      ord: 1,
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
      created_at: now,
      updated_at: now,
    })
    .execute()

  await db
    .insertInto('channel_settings')
    .values({
      channel_id: CHANNEL_ID,
      enabled: false, // намеренно OFF в public — реплей должен принудительно включить copy
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

  for (const [symbol, mmr, maxLev] of [
    ['LITUSDT', '0.02', '25'],
    ['SOLUSDT', '0.005', '25'],
  ] as const) {
    await db
      .insertInto('instruments')
      .values({
        symbol,
        network: NETWORK,
        base_coin: symbol.replace(/USDT$/, ''),
        status: 'Trading',
        qty_step: '0.1',
        min_qty: '0.1',
        tick_size: '0.0001',
        min_notional: '5',
        max_leverage: maxLev,
        leverage_step: '0.01',
        mmr,
        refreshed_at: now,
      })
      .execute()
  }

  let i = 0
  for (const fx of FIXTURE) {
    await db
      .insertInto('messages')
      .values({
        channel_id: CHANNEL_ID,
        tg_message_id: fx.id,
        reply_to_msg_id: fx.reply,
        grouped_id: null,
        is_topic_message: false,
        text: fx.text,
        has_media: false,
        media_kind: null,
        msg_ts: new Date(Date.UTC(2025, 5, 1, 0, i++, 0)),
        raw: JSON.stringify(fx),
        status: 'received',
      })
      .execute()
  }
}

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)
  await seedPublic()
})

afterAll(async () => {
  await sql`DROP SCHEMA IF EXISTS backtest_run CASCADE`.execute(db).catch(() => {})
  await db.destroy()
})

function runReplay(): Promise<BacktestReport> {
  return replay({
    channelKey: CHANNEL_ID,
    databaseUrl: process.env.DATABASE_URL!,
    network: NETWORK,
    equity: '1000',
    kline: new MockKline(),
  })
}

describe('replay — реплей CH1 в изолированной схеме', () => {
  let report: BacktestReport

  it('прогоняет фикстуру и собирает ожидаемые числа', async () => {
    report = await runReplay()

    expect(report.messages).toBe(6)
    expect(report.executed).toBe(1) // LIT вошёл бы (copy принудительно включён, хотя в public off)
    expect(report.deltasExecuted).toBe(1) // дельта "первая цель есть" по LIT
    expect(report.skipped['no_SL']).toBe(1)
    expect(report.skipped['symbol_not_listed']).toBe(1)
    expect(report.skipped['price_slippage']).toBe(1)
    expect(report.byGuard['price_slippage']).toBe(1)
    expect(report.entriesGuarded).toBe(1)
    expect(report.signals).toBe(4) // 1 executed open + 3 skipped opens
    expect(report.aiRequired).toBe(0) // CH1 детерминирован
    // Статус СООБЩЕНИЯ 'executed' = прошло через executing-ветку пайплайна (даже если intent потом
    // отсеял гвард): 1000 (LIT вход), 1001 (дельта), 1005 (SOL — route execute, но price_slippage).
    // Action-уровневый report.executed=1 (реально открытые сделки) считается отдельно и верно.
    expect(report.statusBreakdown['executed']).toBe(3)
    expect(report.statusBreakdown['skipped']).toBe(2) // 1002 no_SL, 1003 symbol_not_listed (route=skip)
    expect(report.statusBreakdown['noise']).toBe(1)
  })

  it('симулирует PnL по траектории (LIT short берёт все TP -> прибыль)', () => {
    expect(report.pnl.tradesEvaluated).toBe(1)
    expect(report.pnl.tradesWithOutcome).toBe(1)
    expect(report.pnl.hitTp).toBe(1)
    expect(report.pnl.wins).toBe(1)
    expect(report.simulatedPnl).not.toBeNull()
    expect(Number(report.simulatedPnl!)).toBeGreaterThan(0)
  })

  it('public НЕ изменён и схема backtest_run дропнута', async () => {
    expect(report.isolation.publicUnchanged).toBe(true)

    // сообщения public остались в статусе received (реплей их не трогал)
    const stillReceived = await db
      .selectFrom('messages')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('channel_id', '=', CHANNEL_ID)
      .where('status', '=', 'received')
      .executeTakeFirstOrThrow()
    expect(Number(stillReceived.n)).toBe(6)

    // в public не появилось ни actions, ни trades
    const pubActions = await db.selectFrom('actions').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow()
    const pubTrades = await db.selectFrom('trades').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow()
    expect(Number(pubActions.n)).toBe(0)
    expect(Number(pubTrades.n)).toBe(0)

    // схема дропнута
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = 'backtest_run'`.execute(db)
    expect(Number(rows[0]?.n)).toBe(0)
  })

  it('детерминизм: второй прогон на тех же входах даёт идентичный отчёт', async () => {
    const r2 = await runReplay()
    expect(JSON.stringify(r2)).toBe(JSON.stringify(report))
  })
})
