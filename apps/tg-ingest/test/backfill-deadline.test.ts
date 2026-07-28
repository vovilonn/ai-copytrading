import { describe, it, expect } from 'vitest'
import { probeConnection, withDeadline } from '../src/ingest.service.js'

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

// Сторож живости соединения (ingest.service.ts::probeConnection). Живой инцидент 28.07.2026:
// сокет MTProto закрылся в 13:04, GramJS сам не восстановился, UpdateConnectionState(connected)
// больше не приходил — реконнект-детектор не сработал НИ РАЗУ, и воркер молча не получал
// сообщения 48 минут. Сигнал канала за это время протух: цена ушла на 4%, вход отбился гейтом
// price_slippage. Отсюда независимая от событий GramJS проверка «жив ли канал связи».
describe('probeConnection — сторож живости соединения', () => {
  it('связь отвечает -> ничего не трогаем (ни реконнекта, ни лишнего бэкфилла)', async () => {
    const calls: string[] = []
    await probeConnection({
      probe: async () => calls.push('probe'),
      reconnect: async () => calls.push('reconnect'),
      backfill: async () => void calls.push('backfill'),
      onError: (label) => calls.push(`error:${label}`),
    })

    expect(calls).toEqual(['probe'])
  })

  it('связь не отвечает -> переподключаемся и догоняем историю', async () => {
    const calls: string[] = []
    await probeConnection({
      probe: async () => {
        calls.push('probe')
        throw new Error('updates.GetState: превышен потолок 15000 мс')
      },
      reconnect: async () => calls.push('reconnect'),
      backfill: async () => void calls.push('backfill'),
      onError: (label) => calls.push(`error:${label}`),
    })

    expect(calls).toEqual(['probe', 'reconnect', 'backfill'])
  })

  it('переподключение не удалось -> залогировано, исключение НЕ наружу (следующий тик повторит)', async () => {
    const errors: string[] = []
    await expect(
      probeConnection({
        probe: async () => {
          throw new Error('нет связи')
        },
        reconnect: async () => {
          throw new Error('сеть недоступна')
        },
        backfill: async () => {},
        onError: (label, err) => errors.push(`${label}: ${String(err)}`),
      }),
    ).resolves.toBeUndefined()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('сеть недоступна')
  })
})
