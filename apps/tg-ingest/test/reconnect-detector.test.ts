import { describe, it, expect, vi } from 'vitest'
import { UpdateConnectionState } from 'telegram/network/index.js'
import { createReconnectDetector } from '../src/ingest.service.js'

// Регрессия: GramJS шлёт UpdateConnectionState.connected КАЖДЫЕ 9 секунд на здоровом соединении
// (PING_INTERVAL_TO_WAKE_UP=5000 < PING_INTERVAL=9000 в telegram/client/updates.js — ветка
// «проснулись из фона» выбирается всегда и безусловно диспатчит connected). Раньше обработчик
// трактовал это как реконнект и гонял полный backfillAll → ~19 000 getHistory в сутки вместо 288.
describe('createReconnectDetector', () => {
  const { connected, disconnected, broken } = UpdateConnectionState

  it('НЕ считает реконнектом повторные connected на живой связи (фантомный keepalive)', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    for (let i = 0; i < 10; i++) detect(connected)

    expect(onReconnected).not.toHaveBeenCalled()
  })

  it('срабатывает ровно один раз на фронте disconnected → connected', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    detect(disconnected)
    detect(connected)

    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('после реального реконнекта следующие keepalive снова игнорируются', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    detect(disconnected)
    detect(connected) // настоящий догон
    detect(connected) // keepalive
    detect(connected) // keepalive

    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('broken (обрыв без штатного disconnect) тоже открывает фронт', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    detect(broken)
    detect(connected)

    expect(onReconnected).toHaveBeenCalledTimes(1)
  })

  it('каждый новый разрыв даёт новый догон', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    detect(disconnected)
    detect(connected)
    detect(disconnected)
    detect(connected)

    expect(onReconnected).toHaveBeenCalledTimes(2)
  })

  it('серия connected до первого разрыва не догоняет (start() уже сделал бэкфилл сам)', () => {
    const onReconnected = vi.fn()
    const detect = createReconnectDetector(onReconnected)

    detect(connected)
    detect(connected)
    detect(disconnected)
    detect(connected)

    expect(onReconnected).toHaveBeenCalledTimes(1)
  })
})
