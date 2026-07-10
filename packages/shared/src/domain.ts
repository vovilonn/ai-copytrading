// Доменные типы, общие для api и будущего engine (Ф1+). Пока единственный тип — Instrument
// (задача 1: кэш instruments-info + risk-limit, см. apps/api/src/instruments/instruments.service.ts),
// сюда же по мере задач Ф1 добавятся Action/Trade/Order и т.п.

export type Network = 'testnet' | 'mainnet'

/**
 * Строка кэша инструментов Bybit (таблица `instruments`, apps/api/src/db/migrations/001_initial.ts
 * + 003_instruments_mmr.ts). Гейт торговли — `status === 'Trading'`. Денежные/шаговые поля —
 * строки (NUMERIC из Postgres), не number: округления qty/price делаются Decimal-арифметикой
 * в engine, а не float.
 */
export interface Instrument {
  symbol: string
  network: Network
  baseCoin: string
  status: string
  qtyStep: string
  minQty: string
  tickSize: string
  minNotional: string
  maxLeverage: string
  leverageStep: string
  // MMR (maintenance margin rate) risk-limit tier1. null — если Bybit не отдал risk-limit
  // тиры для символа на этой сети (напр. делистнутый инструмент, retCode=10001).
  mmr: string | null
  refreshedAt: string // ISO
}
