import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { loadConfig } from '../src/config/config.schema.js'
import { DatabaseService } from '../src/db/database.service.js'
import { InstrumentsService } from '../src/instruments/instruments.service.js'

// Бриф задачи 1: тест реально ходит в Bybit testnet (публичный эндпоинт instruments-info/
// risk-limit, ключ не нужен). Если сеть недоступна — не роняем весь прогон `pnpm test`, а
// явно skip'аем с сообщением; по умолчанию (сеть есть) тесты гоняются взаправду.
// Top-level await — модуль ESM, vitest это поддерживает; проверка выполняется один раз при
// загрузке файла, до сборки describe/it (skipIf нужен boolean уже на этот момент).
let networkAvailable = true
try {
  const res = await fetch('https://api-testnet.bybit.com/v5/market/time', {
    signal: AbortSignal.timeout(5_000),
  })
  networkAvailable = res.ok
} catch {
  networkAvailable = false
}
if (!networkAvailable) {
  // eslint-disable-next-line no-console -- сообщение о skip обязано быть видно в выводе прогона
  console.warn('[instruments.e2e.test] Bybit testnet недоступен — живые тесты пропущены (skip)')
}

let db: Kysely<DB>
let service: InstrumentsService

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  // Провайдеры собраны вручную (не через Nest DI/createApp): у InstrumentsService нет
  // HTTP-контроллера, а DatabaseService — простой конструктор с @Inject(APP_CONFIG),
  // который прекрасно строится напрямую (тот же приём, что и createDb в migration.test.ts).
  const config = loadConfig(process.env)
  const database = new DatabaseService(config)
  service = new InstrumentsService(database, config)
})

afterAll(async () => {
  await db.destroy()
})

// Important #1 финального ревью Ф1: refresh() существовал, но его никто не вызывал — на чистой
// БД instruments пустая, каждый сигнал уходил в symbol_not_listed. Юнит проверяет ИМЕННО связку
// "bootstrap вызывает refresh()", а не сам живой Bybit (тот уже покрыт describe ниже) — refresh
// замокан, поэтому не зависит от networkAvailable и не требует реальной сети. Отдельный экземпляр
// сервиса (не общий `service` из beforeAll выше) — чтобы vi.spyOn не задел живые тесты ниже.
describe('InstrumentsService.onModuleInit (Important #1)', () => {
  it('вызывает refresh() в фоне при старте api, не дожидаясь его завершения (fire-and-forget)', async () => {
    const config = loadConfig(process.env)
    const database = new DatabaseService(config)
    const own = new InstrumentsService(database, config)
    const refreshSpy = vi.spyOn(own, 'refresh').mockResolvedValue(42)

    await own.onModuleInit()
    // onModuleInit не await'ит сам refresh (иначе недоступность Bybit при старте блокировала бы
    // api) — ждём микротаск, чтобы фоновый вызов успел стартовать.
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1))
  })

  it('падение refresh() при старте не пробрасывается наружу из onModuleInit (не роняет bootstrap api)', async () => {
    const config = loadConfig(process.env)
    const database = new DatabaseService(config)
    const own = new InstrumentsService(database, config)
    vi.spyOn(own, 'refresh').mockRejectedValue(new Error('Bybit недоступен'))

    await expect(own.onModuleInit()).resolves.toBeUndefined()
  })
})

describe.skipIf(!networkAvailable)('InstrumentsService (живой Bybit testnet)', () => {
  it(
    'refresh() наполняет instruments с публичного instruments-info/risk-limit (>100 строк)',
    async () => {
      const count = await service.refresh()
      expect(count).toBeGreaterThan(100)
    },
    30_000,
  )

  it("isTrading('BTCUSDT') -> true (реально торгуется на testnet)", async () => {
    expect(await service.isTrading('BTCUSDT')).toBe(true)
  })

  it('после refresh() в кэше нет дефисных фьючерсов (BTC-*/BTCUSDT-*) и USDC-перпов — только USDT-перпетуалы', async () => {
    const dashed = await db.selectFrom('instruments').select('symbol').where('symbol', 'like', '%-%').execute()
    expect(dashed).toEqual([])
  })

  it("на testnet GRASSUSDT известен кэшу, но не торгуется (status != 'Trading')", async () => {
    // GRASSUSDT/EIGENUSDT отсутствуют в bulk-листинге 'Trading' на testnet, но существуют как
    // делистнутые (status='Closed') — см. §13 research-дока и комментарий в bybit-client.ts.
    expect(await service.isTrading('GRASSUSDT')).toBe(false)

    const grass = await service.get('GRASSUSDT')
    expect(grass).not.toBeNull()
    expect(grass?.status).not.toBe('Trading')
  })

  it("get('BTCUSDT') отдаёт округления/плечо/MMR строками", async () => {
    const btc = await service.get('BTCUSDT')
    expect(btc).not.toBeNull()
    expect(typeof btc?.qtyStep).toBe('string')
    expect(btc?.qtyStep).toBeTruthy()
    expect(btc?.tickSize).toBeTruthy()
    expect(btc?.maxLeverage).toBeTruthy()
    // MMR tier1 BTCUSDT = 0.005 — живое значение risk-limit (см. §6 research-дока).
    // NUMERIC(10,6) в Postgres хранит хвостовые нули ('0.005000'), поэтому сравниваем
    // как число (тот же приём, что в migration.test.ts для NUMERIC-колонок).
    expect(Number(btc?.mmr)).toBe(0.005)
  })
})
