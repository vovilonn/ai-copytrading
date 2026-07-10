import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../src/lib/api.js'

// Дефект Ф0 (task-12c): HTTP API смонтирован под префиксом /api (apps/api/src/app.ts,
// setGlobalPrefix('api')) — без этого прокси Vite не может отличить SPA-роут /channels/:id
// от HTTP-запроса к API, и жёсткая перезагрузка страницы канала отдаёт сырой JSON вместо
// приложения. apiFetch — единственное место фронта, которое знает про этот префикс:
// вызывающий код (useAuth, routes/*.tsx, MessageTimeline) передаёт путь БЕЗ /api, как раньше.
// Здесь фейкается сам global.fetch (а не apiFetch, как в остальных тестах) — иначе подмену
// префикса нечем было бы проверить.
describe('apiFetch', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('подставляет префикс /api перед путём запроса', async () => {
    await apiFetch('/channels')
    expect(global.fetch).toHaveBeenCalledWith('/api/channels', expect.anything())
  })

  it('подставляет префикс и для вложенных путей с query-строкой', async () => {
    await apiFetch('/channels/1/messages?limit=50')
    expect(global.fetch).toHaveBeenCalledWith('/api/channels/1/messages?limit=50', expect.anything())
  })

  it('подставляет префикс для /auth/*', async () => {
    await apiFetch('/auth/logout', { method: 'POST' })
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/logout', expect.anything())
  })
})
