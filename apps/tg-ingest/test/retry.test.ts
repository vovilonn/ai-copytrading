import { describe, it, expect, vi } from 'vitest'
import { FloodWaitError } from 'telegram/errors/index.js'
import { withDownloadRetry } from '../src/retry.js'

describe('withDownloadRetry', () => {
  it('успех с первой попытки — sleep не вызывается вовсе', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const fn = vi.fn(async () => 'ok')

    const result = await withDownloadRetry('t', fn, { sleep })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('падает дважды, успевает на третьей попытке — задержки 1с потом 3с', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('flaky 1'))
      .mockRejectedValueOnce(new Error('flaky 2'))
      .mockResolvedValueOnce('ok')

    const result = await withDownloadRetry('t', fn, { sleep, delaysMs: [1000, 3000, 9000] })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000])
  })

  it('исчерпывает все попытки (1с/3с/9с) и бросает последнюю ошибку', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const lastError = new Error('окончательный сбой')
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockRejectedValueOnce(lastError)

    await expect(withDownloadRetry('t', fn, { sleep, delaysMs: [1000, 3000, 9000] })).rejects.toBe(lastError)
    // 4 попытки всего (1 исходная + 3 повтора), но всего 3 sleep — после последней не ждём.
    expect(fn).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000, 9000])
  })

  it('FloodWaitError ждёт err.seconds + 1 вместо шага расписания', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const flood = new FloodWaitError({ capture: 5 })
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(flood).mockResolvedValueOnce('ok')

    const result = await withDownloadRetry('t', fn, { sleep, delaysMs: [1000, 3000, 9000] })

    expect(result).toBe('ok')
    expect(sleep).toHaveBeenCalledWith(6000) // (5 + 1) * 1000, НЕ 1000 из расписания
  })

  it('логирует каждую неудачную попытку', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('e1')).mockResolvedValueOnce('ok')

    await withDownloadRetry('label-x', fn, { sleep })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('label-x')
    warnSpy.mockRestore()
  })
})
