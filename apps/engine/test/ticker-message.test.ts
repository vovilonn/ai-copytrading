import { describe, expect, it } from 'vitest'
import { parseMarkPriceTick } from '../src/market-data/ticker-message.js'

// research bybit-execution.md §12 — живой фрагмент реального потока tickers.BTCUSDT.

describe('parseMarkPriceTick', () => {
  it('snapshot с markPrice -> {symbol, markPrice}', () => {
    const raw = JSON.stringify({
      topic: 'tickers.BTCUSDT',
      type: 'snapshot',
      data: { symbol: 'BTCUSDT', markPrice: '62850.70', indexPrice: '63236.75', lastPrice: '62835.60' },
      ts: 1700000000000,
    })
    expect(parseMarkPriceTick(raw)).toEqual({ symbol: 'BTCUSDT', markPrice: '62850.70' })
  })

  it('delta с markPrice -> тик применяется', () => {
    const raw = JSON.stringify({
      topic: 'tickers.BTCUSDT',
      type: 'delta',
      data: { markPrice: '62850.55', indexPrice: '63236.80' },
    })
    expect(parseMarkPriceTick(raw)).toEqual({ symbol: 'BTCUSDT', markPrice: '62850.55' })
  })

  it('delta БЕЗ markPrice (например, только ask1Price) -> null, не выдумываем цену', () => {
    const raw = JSON.stringify({
      topic: 'tickers.BTCUSDT',
      type: 'delta',
      data: { ask1Price: '62835.70' },
    })
    expect(parseMarkPriceTick(raw)).toBeNull()
  })

  it('служебный фрейм без topic (ack подписки/pong) -> null', () => {
    const raw = JSON.stringify({ success: true, ret_msg: '', conn_id: 'abc', op: 'subscribe' })
    expect(parseMarkPriceTick(raw)).toBeNull()
  })

  it('чужой топик (не tickers.) -> null', () => {
    const raw = JSON.stringify({ topic: 'orderbook.1.BTCUSDT', data: { markPrice: '1' } })
    expect(parseMarkPriceTick(raw)).toBeNull()
  })

  it('битый JSON -> null, не бросает', () => {
    expect(parseMarkPriceTick('{не json')).toBeNull()
  })

  it('символ корректно извлекается из топика (префикс "tickers." отрезан целиком)', () => {
    const raw = JSON.stringify({ topic: 'tickers.ETHUSDT', data: { markPrice: '3242.10' } })
    expect(parseMarkPriceTick(raw)?.symbol).toBe('ETHUSDT')
  })
})
