import { describe, it, expect } from 'vitest'
import { isEngineOrderLinkId, orderLinkId } from '../src/execution/order-link-id.js'

// research bybit-execution.md §8 (идемпотентность): orderLinkId ≤36 символов, [A-Za-z0-9_-],
// детерминирован из координат СООБЩЕНИЯ (не tradeId/orderId — LOOP_STATE.md, ключевая находка).
const VALID_CHARS_RE = /^[A-Za-z0-9_-]+$/

describe('orderLinkId', () => {
  it('пример из брифа: dry_run/channelOrd=2/tgMessageId=221452/actionIndex=0/entry/legIndex=0 -> D02-221452-00-E0', () => {
    const key = orderLinkId({
      mode: 'dry_run',
      channelOrd: 2,
      tgMessageId: 221452,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(key).toBe('D02-221452-00-E0')
  })

  it('детерминирован: тот же вход -> тот же ключ (повторный вызов)', () => {
    const params = {
      mode: 'live' as const,
      channelOrd: 1,
      tgMessageId: 12345,
      actionIndex: 3,
      purpose: 'tp' as const,
      legIndex: 2,
    }
    expect(orderLinkId(params)).toBe(orderLinkId(params))
  })

  it('live-режим -> префикс K', () => {
    const key = orderLinkId({
      mode: 'live',
      channelOrd: 1,
      tgMessageId: 100,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(key.startsWith('K')).toBe(true)
  })

  it('dry-run режим -> префикс D', () => {
    const key = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 100,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(key.startsWith('D')).toBe(true)
  })

  it('channelOrd форматируется двумя цифрами (01, 02)', () => {
    const key1 = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 1,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(key1.startsWith('D01-')).toBe(true)
  })

  it('для TP legIndex входит в ключ (индекс цели в tps[])', () => {
    const tp0 = orderLinkId({
      mode: 'live',
      channelOrd: 2,
      tgMessageId: 221452,
      actionIndex: 1,
      purpose: 'tp',
      legIndex: 0,
    })
    const tp2 = orderLinkId({
      mode: 'live',
      channelOrd: 2,
      tgMessageId: 221452,
      actionIndex: 1,
      purpose: 'tp',
      legIndex: 2,
    })
    expect(tp0).not.toBe(tp2)
    expect(tp0.endsWith('T0')).toBe(true)
    expect(tp2.endsWith('T2')).toBe(true)
  })

  it('для entry/add legIndex всегда 0 (по контракту вызывающей стороны)', () => {
    const entry = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 500,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    const add = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 501,
      actionIndex: 0,
      purpose: 'add',
      legIndex: 0,
    })
    expect(entry.endsWith('E0')).toBe(true)
    expect(add.endsWith('A0')).toBe(true)
  })

  it('разные purpose дают разные однобуквенные коды (E/A/T/S/C/X)', () => {
    const purposes = ['entry', 'add', 'tp', 'sl', 'close', 'cancel'] as const
    const codes = purposes.map(
      (purpose) =>
        orderLinkId({ mode: 'live', channelOrd: 1, tgMessageId: 1, actionIndex: 0, purpose, legIndex: 0 }).slice(-2),
    )
    expect(codes).toEqual(['E0', 'A0', 'T0', 'S0', 'C0', 'X0'])
  })

  it('длина <= 36 символов и алфавит ограничен [A-Za-z0-9_-] — реалистичный tgMessageId (10 цифр)', () => {
    const key = orderLinkId({
      mode: 'live',
      channelOrd: 2,
      tgMessageId: 9999999999, // 10 цифр — верхняя граница из брифа
      actionIndex: 99,
      purpose: 'tp',
      legIndex: 99,
    })
    expect(key.length).toBeLessThanOrEqual(36)
    expect(VALID_CHARS_RE.test(key)).toBe(true)
  })

  it('разные actionIndex дают разные ключи (несколько ордеров в одном сообщении)', () => {
    const a0 = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 700,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    const a1 = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 700,
      actionIndex: 1,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(a0).not.toBe(a1)
  })

  it('разные tgMessageId дают разные ключи', () => {
    const a = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 1,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    const b = orderLinkId({
      mode: 'dry_run',
      channelOrd: 1,
      tgMessageId: 2,
      actionIndex: 0,
      purpose: 'entry',
      legIndex: 0,
    })
    expect(a).not.toBe(b)
  })
})

describe('isEngineOrderLinkId — «наш ли это ключ»', () => {
  it('распознаёт ключи обоих режимов и всех назначений', () => {
    expect(isEngineOrderLinkId(orderLinkId({ mode: 'live', channelOrd: 1, tgMessageId: 2796, actionIndex: 0, purpose: 'entry', legIndex: 0 }))).toBe(true)
    expect(isEngineOrderLinkId(orderLinkId({ mode: 'dry_run', channelOrd: 2, tgMessageId: 1, actionIndex: 3, purpose: 'tp', legIndex: 2 }))).toBe(true)
    expect(isEngineOrderLinkId('K101-45-00-C0')).toBe(true)
  })

  it('НЕ принимает чужие ключи — от них зависит решение «ручное действие оператора»', () => {
    // Пустой orderLinkId — сработавший trading-stop; чужой формат — ручной ордер с биржи;
    // наш уборочный префикс e2e — тоже не ордер движка.
    expect(isEngineOrderLinkId('')).toBe(false)
    expect(isEngineOrderLinkId(null)).toBe(false)
    expect(isEngineOrderLinkId(undefined)).toBe(false)
    expect(isEngineOrderLinkId('E2ECLEAN-1784993424638-SOLUSDT')).toBe(false)
    expect(isEngineOrderLinkId('1784993424638')).toBe(false)
    expect(isEngineOrderLinkId('K101-45-00')).toBe(false) // без кода назначения
    expect(isEngineOrderLinkId('X101-45-00-C0')).toBe(false) // чужой префикс режима
  })
})
