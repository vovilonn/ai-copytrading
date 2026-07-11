import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Kysely } from 'kysely'
import { Decimal } from 'decimal.js'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { createExecutionPort, type ExecutionPort } from '../src/execution/port.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { processMessage, type PipelineDeps, type PipelineMessage } from '../src/pipeline.js'
import { createMarkPriceGetter, type MarkPriceRestClient } from '../src/main.js'

/**
 * Юнит/интеграционные тесты пайплайна на два денежных инварианта, найденных адверсариальным
 * ревью денежного ядра (безопасны в dry-run, но денежные баги в live):
 *
 * Important #1 — «ликвидация за стопом»: SL обязан быть на правильной СТОРОНЕ входа и строго
 * ЗА ценой ликвидации выбранного плеча (handleEntrySignal, apps/engine/src/pipeline.ts).
 * Important #2 — channel_settings.enabled=false обязан гасить ЛЮБОЕ исполнение (ни одного
 * orders/trades/positions), даже если сообщение успешно распарсилось.
 *
 * Полный property-свип d=0.001..0.999 для инварианта #1 — отдельный временный скрипт
 * (см. p1-core-fix-report.md), не часть постоянного набора тестов (он бы дублировал уже
 * существующий property-тест apps/engine/test/leverage.test.ts на уровне chistoй функции).
 */

let db: Kysely<DB>
const deps: PipelineDeps = { executionPort: createExecutionPort('dry_run'), network: 'testnet', equity: '1000' }

// Диапазон id заведомо не пересекается с реальными Telegram channel id (используемыми в
// pipeline.e2e.test.ts/ch1.adapter.test.ts) — resetTestSchema чистит БД перед каждым тестом,
// но разные тесты внутри одного it() всё равно должны получать разные PK.
let nextChannelId = 910_000_001

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  await resetTestSchema(db)
})

interface SeedOpts {
  channelId: number
  symbol: string
  enabled?: boolean
  tradeSize?: string
  qtyStep?: string
}

async function seedChannel(opts: SeedOpts): Promise<void> {
  const now = new Date()
  await db
    .insertInto('channels')
    .values({
      id: opts.channelId,
      ord: 1,
      key: `ch-${opts.channelId}`,
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
      channel_id: opts.channelId,
      enabled: opts.enabled ?? true,
      trade_size: opts.tradeSize ?? '500',
      max_leverage: '50',
      cross_margin: true,
      no_sl_policy: 'attach_protective_sl',
      no_sl_buffer_sec: 0,
      add_sizing_mode: 'trade_size',
      mirror_manual_fraction: false,
      limit_ttl_sec: 604_800,
      updated_at: now,
    })
    .execute()

  await db
    .insertInto('instruments')
    .values({
      symbol: opts.symbol,
      network: 'testnet',
      base_coin: opts.symbol.replace(/USDT$/, ''),
      status: 'Trading',
      qty_step: opts.qtyStep ?? '0.01',
      min_qty: opts.qtyStep ?? '0.01',
      tick_size: '0.0001',
      min_notional: '5',
      max_leverage: '50',
      leverage_step: '0.01',
      mmr: '0.005',
      refreshed_at: now,
    })
    .execute()
}

async function insertMessage(channelId: number, tgMessageId: number, text: string): Promise<PipelineMessage> {
  const msgTs = new Date()
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: channelId,
      tg_message_id: tgMessageId,
      reply_to_msg_id: null,
      grouped_id: null,
      is_topic_message: false,
      text,
      has_media: false,
      media_kind: null,
      msg_ts: msgTs,
      raw: JSON.stringify({ id: tgMessageId, text }),
      status: 'received',
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  return {
    id: row.id,
    channelId,
    tgMessageId,
    replyToMsgId: null,
    groupedId: null,
    text,
    mediaKind: null,
    msgTs,
  }
}

async function actionFor(channelId: number, tgMessageId: number) {
  const message = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', channelId)
    .where('tg_message_id', '=', tgMessageId)
    .executeTakeFirstOrThrow()
  return db
    .selectFrom('actions')
    .selectAll()
    .where('message_id', '=', message.id)
    .where('action_index', '=', 0)
    .executeTakeFirstOrThrow()
}

/**
 * Спай над DryRunAdapter (Critical C1 адверсариального ревью, p3-core-fix-report.md): записывает
 * порядок/содержание вызовов ExecutionPort, реальную работу делегирует DryRunAdapter — так тест
 * проверяет ИМЕННО то, что pipeline.ts вызывает (stopLoss в placeEntry, ни одного отдельного
 * setStopLoss для исходного входа), независимо от того, какой реальный адаптер это исполняет.
 */
function createRecordingExecutionPort(): { port: ExecutionPort; calls: string[] } {
  const inner = new DryRunAdapter()
  const calls: string[] = []
  const port: ExecutionPort = {
    placeEntry: (tx, order) => {
      calls.push(`placeEntry:stopLoss=${order.stopLoss ?? 'none'}`)
      return inner.placeEntry(tx, order)
    },
    placeTpLadder: (tx, params) => {
      calls.push('placeTpLadder')
      return inner.placeTpLadder(tx, params)
    },
    setStopLoss: (tx, params) => {
      calls.push('setStopLoss')
      return inner.setStopLoss(tx, params)
    },
    closePosition: (tx, params) => {
      calls.push('closePosition')
      return inner.closePosition(tx, params)
    },
    cancelOrder: (tx, params) => {
      calls.push('cancelOrder')
      return inner.cancelOrder(tx, params)
    },
  }
  return { port, calls }
}

describe('pipeline — Critical C1: SL атомарно со входом (не отдельным вызовом после TP-лесенки)', () => {
  it('entry_signal без TP -> placeEntry(stopLoss=SL сигнала), setStopLoss НЕ вызывается отдельно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'ATOMUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000' }
    const text = '#ATOM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    expect(calls).toEqual(['placeEntry:stopLoss=90'])

    // Локальная orders(purpose='sl')-строка всё равно существует (записана АТОМАРНО внутри
    // placeEntry, а не отдельным вызовом) — SL реально применён, не потерян вместе с рефакторингом.
    const slOrder = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).where('purpose', '=', 'sl').executeTakeFirstOrThrow()
    expect(slOrder.price).toBe('90.0000000000')
    expect(slOrder.reduce_only).toBe(true)

    const position = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).where('symbol', '=', 'ATOMUSDT').executeTakeFirstOrThrow()
    expect(position.stop_loss).toBe('90.0000000000')
  })

  it('нормальный сигнал с TP-лесенкой (LIT short, реальный дамп CH1) -> placeEntry(stopLoss=...) -> placeTpLadder, setStopLoss НЕ вызывается', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LITUSDT' })
    const { port, calls } = createRecordingExecutionPort()
    const localDeps: PipelineDeps = { executionPort: port, network: 'testnet', equity: '1000' }
    const text = '#LIT/USDT 📉 SHORT\n\nДиапазон входа: 1.5273-1.4735$\nTP: 1.4428$ - 1.3926$ - 1.2777$\nSL: 1.7137$\n\nРиск: 2%'
    const message = await insertMessage(channelId, 2796, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 2796)
    expect(action.status).toBe('executed')

    expect(calls).toEqual(['placeEntry:stopLoss=1.7137', 'placeTpLadder'])
    expect(calls.includes('setStopLoss')).toBe(false)
  })
})

describe('pipeline — гейт безопасного стопа (Important #1)', () => {
  it('long entry=100 sl=0.4 (корректная сторона, но лев клампится к 1x и liq=0.5 > sl=0.4) -> skip unsafe_stop', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'AAAUSDT' })
    const text = '#AAA/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 0.4$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('unsafe_stop')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
    const positions = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).execute()
    expect(positions).toHaveLength(0)
  })

  it('long entry=100 sl=200 (SL выше входа для лонга — неверная сторона) -> skip invalid_sl_side', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'BBBUSDT' })
    const text = '#BBB/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 200$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('invalid_sl_side')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
  })

  it('нормальный сигнал (LIT short, реальное сообщение #2796 дампа CH1) -> исполняется', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LITUSDT' })
    const text = '#LIT/USDT 📉 SHORT\n\nДиапазон входа: 1.5273-1.4735$\nTP: 1.4428$ - 1.3926$ - 1.2777$\nSL: 1.7137$\n\nРиск: 2%'
    const message = await insertMessage(channelId, 2796, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 2796)
    expect(action.status).toBe('executed')
    expect(action.trade_id).not.toBeNull()

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
    // Decimal-точная середина диапазона (1.5273+1.4735)/2=1.5004 (Minor #3 — не JS-float).
    // NUMERIC(30,10) в Postgres возвращает значение с полным масштабом колонки — сравниваем
    // через Decimal, а не строкой, чтобы не зависеть от количества хвостовых нулей.
    expect(new Decimal(trades[0]?.avg_entry ?? '0').toString()).toBe('1.5004')

    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders.length).toBeGreaterThan(0)
  })
})

describe('pipeline — channel_settings.enabled (Important #2)', () => {
  it('enabled=false -> action skipped/copy_disabled, 0 orders/trades/positions', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'CCCUSDT', enabled: false })
    const text = '#CCC/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('copy_disabled')
    // Action всё же создан (для UI/таймлайна) — символ/тип видны, просто не исполнено.
    expect(action.symbol).toBe('CCCUSDT')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
    const positions = await db.selectFrom('positions').selectAll().where('channel_id', '=', channelId).execute()
    expect(positions).toHaveLength(0)
    const ownership = await db.selectFrom('symbol_ownership').selectAll().where('channel_id', '=', channelId).execute()
    expect(ownership).toHaveLength(0) // символ не захвачен вовсе
  })

  it('enabled=true -> исполняется как раньше (без регрессии)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'DDDUSDT', enabled: true })
    const text = '#DDD/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders.length).toBeGreaterThan(0)
  })
})

describe('pipeline — TP-лесенка без нулевых долей (Minor #4)', () => {
  it('total=2, qtyStep=1, 3 цели -> НИ ОДНОГО tp-ордера с qty=0, весь объём в последней цели', async () => {
    const channelId = nextChannelId++
    // qtyStep='1' (грубый шаг) + tradeSize='100' + entry=50 -> notional=100, qty=floor_to(1,2)=2.
    // 2/3 < 1 -> первые две доли splitQtyEvenly обнулились бы без фильтра buildTpTargets.
    await seedChannel({ channelId, symbol: 'EEEUSDT', tradeSize: '100', qtyStep: '1' })
    const text = '#EEE/USDT 📈LONG\n\nДиапазон входа: 50 - 50$\nTP: 60$ - 65$ - 70$\nSL: 45$'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const tpOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('channel_id', '=', channelId)
      .where('purpose', '=', 'tp')
      .execute()

    expect(tpOrders.every((o) => o.qty !== '0')).toBe(true)
    const totalTpQty = tpOrders.reduce((sum, o) => sum + Number(o.qty), 0)
    expect(totalTpQty).toBe(2) // весь qty ушёл в TP-ордера (одной или несколькими не-нулевыми целями)
  })
})

describe('pipeline — гейт staleness/slippage перед market-входом (Important I2)', () => {
  it('deps.getMarkPrice не подключён (dry_run, как в main.ts) -> гейт fail-open, вход как раньше', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'FFFUSDT' })
    // `deps` модуля — createExecutionPort('dry_run'), БЕЗ getMarkPrice (тот же контракт, что и
    // main.ts в dry_run) — гейт из pipeline.ts::handleEntrySignal не должен даже попытаться его
    // вызвать (сети попросту нет).
    const text = '#FFF/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, deps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
  })

  it('mark 6% выше сигнальной цены (100 -> 106), порог 0.5% по умолчанию -> skip price_slippage, 0 ордеров', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'GGGUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: async () => '106',
    }
    const text = '#GGG/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('price_slippage')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
  })

  it('mark 0.2% выше сигнальной цены (100 -> 100.2), в пределах порога 0.5% -> входит как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'HHHUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: async () => '100.2',
    }
    const text = '#HHH/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
  })

  it('кастомный порог maxEntrySlippagePct — 6% отклонение проходит, если порог поднят до 10%', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'IIIUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: async () => '106',
      maxEntrySlippagePct: '10',
    }
    const text = '#III/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
  })

  it('getMarkPrice возвращает null (сбой похода за ценой/тикер недоступен) -> гейт fail-CLOSED, skip mark_price_unavailable', async () => {
    // Фикс p3-slippage-fix (Important, найден e2e): раньше null тихо пропускал проверку
    // отклонения (fail-open) — торговая система входила вслепую по протухшему сигналу, если
    // сам поход за ценой сломался. Теперь null -> skip, а не молчаливый вход.
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'JJJUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: async () => null,
    }
    const text = '#JJJ/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')

    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(0)
    const orders = await db.selectFrom('orders').selectAll().where('channel_id', '=', channelId).execute()
    expect(orders).toHaveLength(0)
  })
})

describe('pipeline — createMarkPriceGetter(main.ts) + гейт I2, сквозь мок публичного тикера (фикс p3-slippage-fix)', () => {
  /** Мок rest-клиента с ЕДИНСТВЕННЫМ методом, нужным createMarkPriceGetter — getTicker. Тот же
   *  приём, что и createMockRest() в main-live.test.ts (мок узкого контракта, не всего BybitRestClient). */
  function mockRest(impl: MarkPriceRestClient['getTicker']): MarkPriceRestClient {
    return { getTicker: impl }
  }

  it('getTicker -> markPrice=106 при сигнале entry=100 (6% отклонение) -> skip price_slippage', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'KKKUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '106', lastPrice: '106' }))),
    }
    const text = '#KKK/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('price_slippage')
  })

  it('getTicker -> markPrice=100.2 (0.2% отклонение, в пределах порога 0.5%) -> входит как обычно', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'LLLUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '100.2', lastPrice: '100.2' }))),
    }
    const text = '#LLL/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed')
    const trades = await db.selectFrom('trades').selectAll().where('channel_id', '=', channelId).execute()
    expect(trades).toHaveLength(1)
  })

  it('getTicker бросает (сеть/биржа недоступна) -> createMarkPriceGetter -> null -> skip mark_price_unavailable (fail-CLOSED)', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'MMMUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: createMarkPriceGetter(
        mockRest(async () => {
          throw new Error('Bybit сеть (/v5/market/tickers): connection reset')
        }),
      ),
    }
    const text = '#MMM/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')
  })

  it('getTicker -> markPrice/lastPrice оба пусты (тикер вернул пустые строки) -> null -> skip mark_price_unavailable', async () => {
    // Защита от "тикер ответил, но без цены" (напр. delisted/приостановленный символ) — та же
    // логика fail-closed, что и для полного сбоя похода за ценой.
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'NNNUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '', lastPrice: '' }))),
    }
    const text = '#NNN/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('skipped')
    expect(action.skip_reason).toBe('mark_price_unavailable')
  })

  it('getTicker -> markPrice пуст, но lastPrice непуст -> используется lastPrice как fallback', async () => {
    const channelId = nextChannelId++
    await seedChannel({ channelId, symbol: 'OOOUSDT' })
    const localDeps: PipelineDeps = {
      executionPort: createExecutionPort('dry_run'),
      network: 'testnet',
      equity: '1000',
      getMarkPrice: createMarkPriceGetter(mockRest(async () => ({ markPrice: '', lastPrice: '100.1' }))),
    }
    const text = '#OOO/USDT 📈LONG\n\nДиапазон входа: 100 - 100$\nSL: 90$\n\nРиск: 1%'
    const message = await insertMessage(channelId, 1, text)
    await processMessage(db, message, localDeps)

    const action = await actionFor(channelId, 1)
    expect(action.status).toBe('executed') // 0.1% отклонение, в пределах порога 0.5%
  })
})
