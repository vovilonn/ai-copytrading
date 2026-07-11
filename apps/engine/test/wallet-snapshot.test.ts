import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { writeWalletSnapshot, type WalletSnapshotRestClient } from '../src/state/wallet-snapshot.js'

// Писатель wallet_snapshots (задача 3, план 2026-07-12-monitoring-pnl-balance.md, Task 3):
// мок getWalletBalance -> writeWalletSnapshot вставляет ровно одну строку с channel_id=null,
// total_equity/available_balance из ответа мока, currency='USDT'. Против copytrade_test (как
// trades.test.ts/equity.test.ts).

let db: Kysely<DB>

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

function createMockRest(totalEquity: string, totalAvailableBalance: string): { rest: WalletSnapshotRestClient; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async () => ({ totalEquity, totalAvailableBalance, coins: [] }))
  return { rest: { getWalletBalance: fn }, fn }
}

describe('writeWalletSnapshot', () => {
  it('вставляет строку wallet_snapshots: channel_id=null, total_equity/available_balance из мока, currency=USDT', async () => {
    const { rest, fn } = createMockRest('12345.6789', '9000.5')

    await writeWalletSnapshot(db, rest)

    expect(fn).toHaveBeenCalledTimes(1)

    const rows = await db.selectFrom('wallet_snapshots').selectAll().execute()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.channel_id).toBeNull()
    expect(row.total_equity).toBe('12345.6789000000') // NUMERIC(30,10) — строка
    expect(row.available_balance).toBe('9000.5000000000')
    expect(row.currency).toBe('USDT')
    expect(row.created_at).toBeInstanceOf(Date)
  })

  it('каждый вызов пишет НОВУЮ строку (история снапшотов, не upsert)', async () => {
    const first = createMockRest('1000', '900')
    const second = createMockRest('1100', '950')

    await writeWalletSnapshot(db, first.rest)
    await writeWalletSnapshot(db, second.rest)

    const rows = await db.selectFrom('wallet_snapshots').selectAll().orderBy('created_at', 'asc').execute()
    expect(rows).toHaveLength(2)
    expect(rows[0]!.total_equity).toBe('1000.0000000000')
    expect(rows[1]!.total_equity).toBe('1100.0000000000')
  })

  it('ошибка getWalletBalance пробрасывается наружу (main.ts сам решает try/catch — писатель не глотает)', async () => {
    const fn = vi.fn(async () => {
      throw new Error('Bybit сеть недоступна')
    })

    await expect(writeWalletSnapshot(db, { getWalletBalance: fn })).rejects.toThrow('Bybit сеть недоступна')

    const rows = await db.selectFrom('wallet_snapshots').selectAll().execute()
    expect(rows).toHaveLength(0)
  })
})
