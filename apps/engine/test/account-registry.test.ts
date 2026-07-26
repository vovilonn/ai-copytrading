import { describe, it, expect, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import {
  accountFingerprint,
  buildAccountRegistry,
  type CreateRuntimeParams,
} from '../src/runtime/account-registry.js'

// Реестр аккаунтов (runtime/account-registry.ts) — чистая логика группировки: БД и сеть здесь
// подменены, потому что проверяется именно решение «какой канал каким аккаунтом торгует».

const db = {} as Kysely<DB>
const silent = { log: () => {}, warn: () => {}, error: () => {} }

/** Мок сборки клиентов: вместо REST/WS — метка, по которой видно, сколько рантаймов создано. */
function stubRuntime(params: CreateRuntimeParams): ReturnType<typeof makeStub> {
  return makeStub(params)
}
function makeStub(params: CreateRuntimeParams) {
  return {
    fingerprint: params.fingerprint,
    shared: params.shared,
    rest: { id: params.fingerprint } as never,
    executionPort: { id: params.fingerprint } as never,
    privateWs: { id: params.fingerprint, channelIds: params.channelIds } as never,
  }
}

describe('AccountRegistry — какой канал каким аккаунтом торгует', () => {
  it('каналы без своих ключей попадают в ОДИН общий рантайм (поведение до задачи не меняется)', async () => {
    const create = vi.fn(stubRuntime)
    const registry = await buildAccountRegistry({
      db,
      network: 'demo',
      channelIds: [1, 2],
      initialEquity: '1000',
      loadKeys: async () => ({ apiKey: 'ENV', apiSecret: 's' }),
      createRuntime: create,
      log: silent,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(registry.all()).toHaveLength(1)
    expect(registry.all()[0]!.shared).toBe(true)
    expect(registry.all()[0]!.channelIds).toEqual([1, 2])
    expect(registry.forChannel(1)).toBe(registry.forChannel(2))
  })

  it('у каждого канала свой ключ — свой рантайм и своя пара клиентов', async () => {
    const create = vi.fn(stubRuntime)
    const registry = await buildAccountRegistry({
      db,
      network: 'demo',
      channelIds: [10, 20],
      initialEquity: '1000',
      loadKeys: async (_db, channelId) => ({ apiKey: channelId === null ? 'ENV' : `KEY-${channelId}`, apiSecret: 's' }),
      createRuntime: create,
      log: silent,
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(registry.forChannel(10)).not.toBe(registry.forChannel(20))
    expect(registry.forChannel(10)!.shared).toBe(false)
    // Каналы аккаунта уходят в приватный WS: он ограничивает ими атрибуцию пушей.
    expect((registry.forChannel(10)!.privateWs as unknown as { channelIds: number[] }).channelIds).toEqual([10])
  })

  it('ОДИНАКОВЫЕ креды у двух каналов → ОДИН рантайм: иначе каждый филл обработался бы дважды', async () => {
    // Ровно режим проверки, о котором просил заказчик: два канала с одними demo-кредами.
    const create = vi.fn(stubRuntime)
    const registry = await buildAccountRegistry({
      db,
      network: 'demo',
      channelIds: [101, 102],
      initialEquity: '1000',
      loadKeys: async (_db, channelId) => ({ apiKey: channelId === null ? 'ENV' : 'SAME-DEMO-KEY', apiSecret: 's' }),
      createRuntime: create,
      log: silent,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(registry.forChannel(101)).toBe(registry.forChannel(102))
    expect(registry.all()[0]!.channelIds).toEqual([101, 102])
    // Ключ не общий (env) — значит это «субаккаунт», просто один на два канала.
    expect(registry.all()[0]!.shared).toBe(false)
  })

  it('канал с непригодными ключами не обслуживается, но не роняет остальные', async () => {
    const registry = await buildAccountRegistry({
      db,
      network: 'demo',
      channelIds: [1, 2],
      initialEquity: '1000',
      loadKeys: async (_db, channelId) => {
        if (channelId === 2) throw new Error('ENCRYPTION_KEY не подходит')
        return { apiKey: 'ENV', apiSecret: 's' }
      },
      createRuntime: stubRuntime,
      log: silent,
    })

    expect(registry.forChannel(1)).not.toBeNull()
    expect(registry.forChannel(2)).toBeNull()
    expect(registry.unavailable()).toEqual([{ channelId: 2, reason: expect.stringContaining('ENCRYPTION_KEY') }])
  })

  it('fingerprint — короткий хеш ключа, а не сам ключ: он идёт в логи и курсоры', () => {
    const fp = accountFingerprint('super-secret-key')
    expect(fp).toHaveLength(8)
    expect(fp).not.toContain('secret')
    expect(accountFingerprint('super-secret-key')).toBe(fp) // детерминирован
    expect(accountFingerprint('another-key')).not.toBe(fp)
  })
})
