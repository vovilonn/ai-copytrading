import { FloodWaitError } from 'telegram/errors/index.js'

export interface RetryOptions {
  /** Задержки МЕЖДУ попытками (мс). Длина массива = число повторов после первой неудачи, т.е.
   *  всего попыток = delaysMs.length + 1. По умолчанию 1с/3с/9с — 3 повтора (бриф задачи 12b). */
  delaysMs?: number[]
  /** Подмена sleep в тестах — не ждать реальные секунды. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Повтор с экспоненциальной задержкой для сетевого I/O скачивания медиа (задача 12b:
 * .superpowers/sdd/task-12b-report.md — раньше сбой сети/FloodWait при бэкфилле терял фотографию
 * навсегда, ошибка только логировалась). Отдельно от withFloodRetry в ingest.service.ts:
 * тот ретраит ТОЛЬКО FloodWaitError для лёгких вызовов (getMessages/getEntity/getDialogs) и не
 * трогает обычные сетевые сбои; здесь ретраятся ЛЮБЫЕ ошибки скачивания, а FloodWaitError —
 * особый случай: ждём err.seconds + 1 вместо шага расписания (Telegram сам сообщил точное время).
 */
export async function withDownloadRetry<T>(label: string, fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? [1000, 3000, 9000]
  const sleep = options.sleep ?? defaultSleep

  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const isLastAttempt = attempt === delays.length
      console.warn(
        `[tg-ingest] скачивание "${label}" неудачно (попытка ${attempt + 1}/${delays.length + 1}):`,
        err,
      )
      if (isLastAttempt) break
      const waitMs = err instanceof FloodWaitError ? (err.seconds + 1) * 1000 : delays[attempt]!
      await sleep(waitMs)
    }
  }
  throw lastErr
}
