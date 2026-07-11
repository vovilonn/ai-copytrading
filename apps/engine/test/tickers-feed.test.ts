import { describe, expect, it } from 'vitest'
import { diffSubscriptions, shouldApplyTick } from '../src/market-data/tickers-feed.js'

describe('diffSubscriptions', () => {
  it('новые символы уходят в toSubscribe, пропавшие — в toUnsubscribe', () => {
    const subscribed = new Set(['BTCUSDT', 'ETHUSDT'])
    const desired = new Set(['ETHUSDT', 'SOLUSDT'])
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(subscribed, desired)
    expect(toSubscribe).toEqual(['SOLUSDT'])
    expect(toUnsubscribe).toEqual(['BTCUSDT'])
  })

  it('пустая разница -> оба списка пустые (не шлём лишних subscribe/unsubscribe)', () => {
    const subscribed = new Set(['BTCUSDT'])
    const desired = new Set(['BTCUSDT'])
    expect(diffSubscriptions(subscribed, desired)).toEqual({ toSubscribe: [], toUnsubscribe: [] })
  })

  it('всё закрыто -> все текущие символы уходят в toUnsubscribe', () => {
    const subscribed = new Set(['BTCUSDT', 'ETHUSDT'])
    const desired = new Set<string>()
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(subscribed, desired)
    expect(toSubscribe).toEqual([])
    expect(toUnsubscribe.sort()).toEqual(['BTCUSDT', 'ETHUSDT'])
  })
})

describe('shouldApplyTick (троттлинг ~1/сек на символ)', () => {
  it('первый тик по символу — всегда применяется', () => {
    expect(shouldApplyTick(new Map(), 'BTCUSDT', Date.now())).toBe(true)
  })

  it('повторный тик раньше 1000мс — отбрасывается', () => {
    const last = new Map([['BTCUSDT', 1000]])
    expect(shouldApplyTick(last, 'BTCUSDT', 1500)).toBe(false)
  })

  it('тик ровно через 1000мс и позже — применяется', () => {
    const last = new Map([['BTCUSDT', 1000]])
    expect(shouldApplyTick(last, 'BTCUSDT', 2000)).toBe(true)
    expect(shouldApplyTick(last, 'BTCUSDT', 2500)).toBe(true)
  })

  it('троттлинг per-символ — другой символ не блокируется чужим таймстампом', () => {
    const last = new Map([['BTCUSDT', 1000]])
    expect(shouldApplyTick(last, 'ETHUSDT', 1100)).toBe(true)
  })

  it('task-11 полировка Б: свой (более длинный) порог для эмита position.upsert через 4й аргумент', () => {
    const lastEmittedAt = new Map([['BTCUSDT', 1000]])
    // 1500мс спустя — прошло бы дефолтный DB-порог (1000мс), но не прошло 2000мс WS-порог.
    expect(shouldApplyTick(lastEmittedAt, 'BTCUSDT', 2500, 2000)).toBe(false)
    // 3000мс спустя — прошли уже оба порога.
    expect(shouldApplyTick(lastEmittedAt, 'BTCUSDT', 3000, 2000)).toBe(true)
  })
})
