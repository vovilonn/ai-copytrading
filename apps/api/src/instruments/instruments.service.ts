import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import type { Selectable } from 'kysely'
import type { Instrument, Network } from 'shared/domain.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/config.schema.js'
import { DatabaseService } from '../db/database.service.js'
import type { DB } from '../db/database.js'
import { fetchAllInstruments, fetchTier1Mmr, mapWithConcurrency, type InstrumentInfoDto } from './bybit-client.js'

type InstrumentRow = Selectable<DB['instruments']>

// Конкурентность точечных risk-limit запросов в refresh() — см. обоснование в bybit-client.ts
// (fetchTier1Mmr).
const RISK_LIMIT_CONCURRENCY = 20

// Держим batch upsert под лимитом параметров Postgres (~65535 на запрос) с большим запасом:
// 12 колонок * 500 строк = 6000 параметров на чанк.
const UPSERT_CHUNK_SIZE = 500

// Листинги/делистинги на Bybit меняются нечасто (не быстрее, чем за часы) — 6ч периодического
// refresh() с запасом достаточно, чтобы кэш не разошёлся с биржей надолго, не гоняя лишний
// трафик на bulk instruments-info+risk-limit (см. bybit-client.ts) слишком часто.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

// Ретраи ТОЛЬКО для самого первого refresh() при старте api (onModuleInit): если Bybit недоступен
// ровно в момент деплоя/рестарта (сеть, релиз биржи и т.п.), не хотим ждать целых 6ч до следующего
// @Interval-тика с пустой таблицей instruments — на чистой БД это ops-gap, из-за которого каждый
// сигнал уходит в symbol_not_listed и торговли нет (финальное ревью Ф1, Important #1). Периодический
// @Interval-тик ниже сам себя не ретраит — при сбое просто ждём следующего тика, там это уже дёшево.
const STARTUP_RETRY_DELAYS_MS = [10_000, 30_000, 60_000]

// unref() — таймер ретрая не должен сам по себе держать процесс живым (в т.ч. в тестах:
// каждый api e2e тест поднимает createApp() через общий AppModule/InstrumentsModule, см.
// apps/api/test/*.e2e.test.ts — фоновый ретрай не имеет права мешать процессу завершиться).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * USDT-перпетуал — единственный тип контракта, с которым работает система: резолвер
 * (symbol-resolver.ts) всегда достраивает символ суффиксом `USDT`. Без этого фильтра
 * bulk-реестр всех статусов (fetchAllInstruments тянет ещё Closed/PreLaunch/Delivering)
 * тащит в кэш и USDC-перпы, и istёкшие квартальные фьючерсы (`BTC-01DEC23`,
 * `BTCUSDT-17JUL26` и т.п., contractType='LinearFutures') — 986 Closed-строк исторического
 * реестра, которые никогда не встретятся в сигнале. `!symbol.includes('-')` — доп.
 * подстраховка "для чистоты": единственное известное исключение из settleCoin/contractType
 * фильтра — легаси-делистнутый `1M-AIDOGEUSDT`, где дефис часть самого тикера, а не
 * разделитель даты экспирации; системе, которая всегда строит символ конкатенацией
 * TICKER+USDT без разделителей, такой тикер всё равно бесполезен.
 */
function isUsdtPerpetual(info: InstrumentInfoDto): boolean {
  return (
    info.settleCoin === 'USDT' &&
    (info.contractType === undefined || info.contractType.includes('Perpetual')) &&
    !info.symbol.includes('-')
  )
}

/**
 * Кэш инструментов Bybit (instruments-info + risk-limit) в таблице `instruments`. Единственный
 * источник для гейта `status === 'Trading'` и данных округления/плеча (qtyStep/tickSize/
 * maxLeverage/mmr) — см. docs/superpowers/research/bybit-execution.md §6-§8.
 */
@Injectable()
export class InstrumentsService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentsService.name)
  private readonly network: Network

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.network = config.bybitNetwork
  }

  /**
   * Ops-gap финального ревью Ф1 (Important #1): на чистой БД таблица instruments пуста, пока
   * никто не вызовет refresh() — раньше это не делал никто. Здесь — при старте api, БЕЗ await
   * (намеренно fire-and-forget): если бы мы дождались, недоступность Bybit ровно на старте
   * (сеть/рестарт биржи) не давала бы api вообще подняться/начать слушать порт. Ошибка ловится
   * целиком внутри runInitialRefresh() — наружу никогда не пробрасывается.
   */
  async onModuleInit(): Promise<void> {
    void this.runInitialRefresh()
  }

  private async runInitialRefresh(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const count = await this.refresh()
        this.logger.log(`refresh() при старте api — ${count} инструмент(ов)`)
        return
      } catch (err) {
        const delay = STARTUP_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) {
          this.logger.error(
            `refresh() при старте api не удался после ${attempt + 1} попыт(ок) — ждём периодический ` +
              `тик (раз в ${REFRESH_INTERVAL_MS}мс)`,
            err instanceof Error ? err.stack : String(err),
          )
          return
        }
        this.logger.warn(
          `refresh() при старте api упал (попытка ${attempt + 1}/${STARTUP_RETRY_DELAYS_MS.length + 1}), повтор через ${delay}мс: ${String(err)}`,
        )
        await sleep(delay)
      }
    }
  }

  /** Периодика (~раз в 6ч, REFRESH_INTERVAL_MS) — инструменты меняются редко, чаще незачем.
   *  Ошибка тут НЕ ретраится сама: следующий тик через 6ч сам является ретраем. */
  @Interval(REFRESH_INTERVAL_MS)
  private async scheduledRefresh(): Promise<void> {
    try {
      const count = await this.refresh()
      this.logger.log(`периодический refresh() — ${count} инструмент(ов)`)
    } catch (err) {
      this.logger.error('периодический refresh() упал — попробуем на следующем тике', err instanceof Error ? err.stack : String(err))
    }
  }

  /** Полностью обновляет реестр активной сети из Bybit. Возвращает число upsert'нутых строк. */
  async refresh(): Promise<number> {
    const instruments = (await fetchAllInstruments(this.network)).filter(isUsdtPerpetual)
    if (instruments.length === 0) return 0

    // MMR имеет смысл только для реально торгуемых символов (risk-limit для делистнутых
    // возвращает retCode=10001) — не тратим запросы на статусы вроде Closed/PreLaunch.
    const tradingSymbols = instruments.filter((i) => i.status === 'Trading').map((i) => i.symbol)
    const mmrList = await mapWithConcurrency(tradingSymbols, RISK_LIMIT_CONCURRENCY, (symbol) =>
      fetchTier1Mmr(this.network, symbol),
    )
    const mmrBySymbol = new Map(tradingSymbols.map((symbol, i) => [symbol, mmrList[i] ?? null]))

    const now = new Date()
    const rows = instruments.map((info) => ({
      symbol: info.symbol,
      network: this.network,
      base_coin: info.baseCoin,
      status: info.status,
      qty_step: info.lotSizeFilter.qtyStep,
      min_qty: info.lotSizeFilter.minOrderQty,
      tick_size: info.priceFilter.tickSize,
      // `|| '5'`, а не `?? '5'`: у старых делистнутых (status=Closed) контрактов minNotionalValue
      // приходит ПУСТОЙ СТРОКОЙ (не отсутствует), а не null/undefined, — на неё `??` не сработает
      // и в БД улетит '' (invalid input syntax for type numeric, проверено вживую на testnet).
      min_notional: info.lotSizeFilter.minNotionalValue || '5',
      max_leverage: info.leverageFilter.maxLeverage,
      leverage_step: info.leverageFilter.leverageStep,
      mmr: mmrBySymbol.get(info.symbol) ?? null,
      refreshed_at: now,
    }))

    const db = this.database.db
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE)
      await db
        .insertInto('instruments')
        .values(chunk)
        .onConflict((oc) =>
          oc.columns(['symbol', 'network']).doUpdateSet((eb) => ({
            base_coin: eb.ref('excluded.base_coin'),
            status: eb.ref('excluded.status'),
            qty_step: eb.ref('excluded.qty_step'),
            min_qty: eb.ref('excluded.min_qty'),
            tick_size: eb.ref('excluded.tick_size'),
            min_notional: eb.ref('excluded.min_notional'),
            max_leverage: eb.ref('excluded.max_leverage'),
            leverage_step: eb.ref('excluded.leverage_step'),
            mmr: eb.ref('excluded.mmr'),
            refreshed_at: eb.ref('excluded.refreshed_at'),
          })),
        )
        .execute()
    }

    return rows.length
  }

  /** Инструмент по символу на активной сети (`BYBIT_NETWORK`), или null, если ещё не в кэше. */
  async get(symbol: string): Promise<Instrument | null> {
    const row = await this.database.db
      .selectFrom('instruments')
      .selectAll()
      .where('symbol', '=', symbol)
      .where('network', '=', this.network)
      .executeTakeFirst()
    return row ? this.toDomain(row) : null
  }

  /** Гейт исполнения: true только если символ есть в кэше и его status==='Trading'. */
  async isTrading(symbol: string): Promise<boolean> {
    const instrument = await this.get(symbol)
    return instrument?.status === 'Trading'
  }

  private toDomain(row: InstrumentRow): Instrument {
    return {
      symbol: row.symbol,
      network: row.network,
      baseCoin: row.base_coin,
      status: row.status,
      qtyStep: row.qty_step,
      minQty: row.min_qty,
      tickSize: row.tick_size,
      minNotional: row.min_notional,
      maxLeverage: row.max_leverage,
      leverageStep: row.leverage_step,
      mmr: row.mmr,
      refreshedAt: row.refreshed_at.toISOString(),
    }
  }
}
