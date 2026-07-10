import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Instrument, Network } from 'shared/domain.js'

/**
 * Тонкий доступ engine к таблице `instruments` (тот же кэш, что наполняет
 * `apps/api/src/instruments/instruments.service.ts`). Engine — отдельный процесс без NestJS DI,
 * поэтому вместо импорта `InstrumentsService` читает ту же таблицу напрямую тем же маппингом
 * строка→домен (см. task-7-brief.md: "сделай тонкий доступ getInstrument/isTrading").
 */
function toDomain(row: {
  symbol: string
  network: Network
  base_coin: string
  status: string
  qty_step: string
  min_qty: string
  tick_size: string
  min_notional: string
  max_leverage: string
  leverage_step: string
  mmr: string | null
  refreshed_at: Date
}): Instrument {
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

/** Инструмент по символу на заданной сети, или null — не в кэше. */
export async function getInstrument(db: Kysely<DB>, symbol: string, network: Network): Promise<Instrument | null> {
  const row = await db
    .selectFrom('instruments')
    .selectAll()
    .where('symbol', '=', symbol)
    .where('network', '=', network)
    .executeTakeFirst()
  return row ? toDomain(row) : null
}

/** Гейт исполнения: true только если символ есть в кэше и его status==='Trading'. */
export async function isTrading(db: Kysely<DB>, symbol: string, network: Network): Promise<boolean> {
  const instrument = await getInstrument(db, symbol, network)
  return instrument?.status === 'Trading'
}

export type InstrumentMap = ReadonlyMap<string, Instrument>

/**
 * Весь кэш инструментов активной сети одним запросом, в Map по символу. Пайплайн вызывает это
 * ОДИН раз на сообщение (не на символ): `ParseContext.isListed`/`resolveSymbol` синхронны по
 * контракту (research §10), а поход в БД — асинхронный, поэтому все нужные символы предзагружаются
 * заранее в память (инструментов — сотни, не миллионы, полная выборка дёшева).
 */
export async function listInstruments(db: Kysely<DB>, network: Network): Promise<InstrumentMap> {
  const rows = await db.selectFrom('instruments').selectAll().where('network', '=', network).execute()
  return new Map(rows.map((row) => [row.symbol, toDomain(row)]))
}
