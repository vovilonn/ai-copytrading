import { describe, it, expect } from 'vitest'
import { ServerClock } from '../src/bybit/server-time.js'

// Часы биржи (bybit/server-time.ts). Поводом стал живой инцидент e2e: после сна ноутбука VM
// Docker ушла на ~5 секунд, Bybit начал отвергать КАЖДЫЙ приватный запрос кодом 10002
// (recv_window 5000 мс), и движок молча ослеп — снапшоты баланса не писались, зеркало позиций
// не обновлялось. Сети здесь нет: источник серверного времени инжектируется.

describe('ServerClock — поправка к локальным часам', () => {
  it('offset считается по СЕРЕДИНЕ интервала запроса (компенсация задержки сети)', async () => {
    let local = 1_000_000
    const clock = new ServerClock(
      async () => {
        local += 200 // сеть «съела» 200 мс между стартом запроса и ответом
        return 1_005_000 // сервер: на 5 секунд впереди в момент ОТВЕТА
      },
      { now: () => local },
    )

    await clock.sync()

    // Локальное время в момент ответа оценивается как (1_000_000 + 1_000_200)/2 = 1_000_100.
    expect(clock.offset).toBe(1_005_000 - 1_000_100)
    expect(clock.nowMs()).toBe(local + clock.offset)
  })

  it('до первой ЯВНОЙ синхронизации ensureFresh не ходит в сеть вовсе', async () => {
    let calls = 0
    const clock = new ServerClock(async () => {
      calls += 1
      return Date.now()
    })

    await clock.ensureFresh()
    await clock.ensureFresh()

    // Юнит-тесты, dry-run и офлайн-прогоны не должны платить сетевым запросом за подпись.
    expect(calls).toBe(0)
    expect(clock.offset).toBe(0)
  })

  it('после явной синхронизации ensureFresh освежает поправку только по истечении TTL', async () => {
    let local = 0
    let calls = 0
    const clock = new ServerClock(
      async () => {
        calls += 1
        return local + 1000 // сервер стабильно на секунду впереди
      },
      { now: () => local, ttlMs: 60_000 },
    )

    await clock.sync()
    expect(calls).toBe(1)

    local += 59_000
    await clock.ensureFresh()
    expect(calls).toBe(1) // TTL ещё не вышел — сети не касаемся

    local += 2_000
    await clock.ensureFresh()
    expect(calls).toBe(2)
  })

  it('одновременные синхронизации схлопываются в один запрос (single-flight)', async () => {
    let calls = 0
    const clock = new ServerClock(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return Date.now()
    })

    await Promise.all([clock.sync(), clock.sync(), clock.sync()])

    expect(calls).toBe(1)
  })

  it('сбой похода за временем НЕ роняет вызов и сохраняет прежнюю поправку', async () => {
    let local = 0
    let mode: 'ok' | 'fail' = 'ok'
    const clock = new ServerClock(
      async () => {
        if (mode === 'fail') throw new Error('network boom')
        return local + 3_000
      },
      { now: () => local, ttlMs: 10 },
    )

    await clock.sync()
    expect(clock.offset).toBe(3_000)

    mode = 'fail'
    local += 1_000
    await expect(clock.sync()).resolves.toBeUndefined() // не бросает
    expect(clock.offset).toBe(3_000) // поправка осталась прежней — торговлю не роняем
  })
})
