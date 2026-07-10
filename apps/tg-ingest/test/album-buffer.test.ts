import { describe, it, expect, vi } from 'vitest'
import { AlbumBuffer } from '../src/album-buffer.js'

const msg = (id: number, groupedId: string | null, text = '') => ({ id, groupedId, text })

it('одиночное сообщение отдаётся сразу', () => {
  const flush = vi.fn()
  new AlbumBuffer(600, flush).push(msg(1, null))
  expect(flush).toHaveBeenCalledWith([msg(1, null)])
})

it('альбом собирается и отдаётся одним пакетом по таймауту', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(11, 'g1', 'подпись'))
  buf.push(msg(12, 'g1'))
  expect(flush).not.toHaveBeenCalled()
  vi.advanceTimersByTime(600)
  expect(flush).toHaveBeenCalledOnce()
  expect(flush.mock.calls[0]![0].map((m: any) => m.id)).toEqual([11, 12])
  vi.useRealTimers()
})

it('каждое новое фото продлевает окно', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(21, 'g2'))
  vi.advanceTimersByTime(500)
  buf.push(msg(22, 'g2'))
  vi.advanceTimersByTime(500)
  expect(flush).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  expect(flush).toHaveBeenCalledOnce()
  vi.useRealTimers()
})

it('элементы альбома сортируются по id', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(32, 'g3')); buf.push(msg(31, 'g3'))
  vi.advanceTimersByTime(600)
  expect(flush.mock.calls[0]![0].map((m: any) => m.id)).toEqual([31, 32])
  vi.useRealTimers()
})

it('drain отдаёт недособранные альбомы (graceful shutdown)', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(41, 'g4'))
  buf.drain()
  expect(flush).toHaveBeenCalledOnce()
  vi.useRealTimers()
})
