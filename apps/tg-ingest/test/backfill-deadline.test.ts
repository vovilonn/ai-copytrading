import { describe, it, expect } from 'vitest'
import { withDeadline } from '../src/ingest.service.js'

// Потолок на проход бэкфилла (ingest.service.ts::backfillAll). Живой e2e показал, чем опасен
// single-flight без него: один зависший вызов GramJS внутри прохода не давал обнулить
// `backfillInFlight`, и ВСЕ последующие попытки (реконнект, таймер, старт) возвращали тот же
// вечно-pending промис. Воркер молча переставал догонять историю — сообщение лежало в Telegram,
// курсор позади него, в БД его не было, в логе ни одной ошибки.

describe('withDeadline — проход не может висеть вечно', () => {
  it('отпускает ожидание по таймауту и объясняет причину', async () => {
    const never = new Promise<void>(() => {}) // зависший сетевой вызов
    await expect(withDeadline(never, 20, 'backfillAll')).rejects.toThrow(/backfillAll: превышен потолок 20 мс/)
  })

  it('успевший промис проходит как есть, таймер не мешает', async () => {
    await expect(withDeadline(Promise.resolve('ок'), 1000, 'backfillAll')).resolves.toBe('ок')
  })

  it('ошибка самого прохода не подменяется таймаутом', async () => {
    await expect(withDeadline(Promise.reject(new Error('flood wait')), 1000, 'backfillAll')).rejects.toThrow('flood wait')
  })
})
