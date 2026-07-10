import { Inject, Injectable } from '@nestjs/common'
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
export class InstrumentsService {
  private readonly network: Network

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.network = config.bybitNetwork
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
