import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/lib/api.js'
import { createQueryClient } from '../src/lib/query-client.js'

// Финальное ревью Ф1, Important #4: до фикса actions.tsx/positions.tsx читали только
// `data ?? []` — 401 (протухшая сессия) неотличим от честного пустого списка. Часть фикса —
// глобальный обработчик 401 на уровне QueryClient (query-client.ts), тестируется здесь напрямую,
// без React: fetchQuery уже триггерит queryCache.onError тем же путём, что и useQuery в компонентах.
describe('createQueryClient — глобальная обработка протухшей сессии', () => {
  it('401 от защищённого запроса сбрасывает кэш auth.me и уводит на /login', async () => {
    const navigate = vi.fn()
    const queryClient = createQueryClient(navigate)
    queryClient.setQueryData(['auth', 'me'], { username: 'admin' })

    await queryClient
      .fetchQuery({ queryKey: ['positions', {}], queryFn: () => Promise.reject(new ApiError('unauthorized', 401)) })
      .catch(() => {})

    expect(navigate).toHaveBeenCalledWith('/login')
    expect(queryClient.getQueryData(['auth', 'me'])).toBeUndefined()
  })

  it('500 (сбой сети/сервера, не сессии) — не редиректит на /login', async () => {
    const navigate = vi.fn()
    const queryClient = createQueryClient(navigate)

    await queryClient
      .fetchQuery({ queryKey: ['positions', {}], queryFn: () => Promise.reject(new ApiError('server error', 500)) })
      .catch(() => {})

    expect(navigate).not.toHaveBeenCalled()
  })

  it('обычная (не ApiError) ошибка — не редиректит на /login', async () => {
    const navigate = vi.fn()
    const queryClient = createQueryClient(navigate)

    await queryClient
      .fetchQuery({ queryKey: ['positions', {}], queryFn: () => Promise.reject(new Error('network down')) })
      .catch(() => {})

    expect(navigate).not.toHaveBeenCalled()
  })

  it('401 на саму auth.me не дёргает navigate повторно — тот случай уже штатно обрабатывает RequireAuth', async () => {
    const navigate = vi.fn()
    const queryClient = createQueryClient(navigate)

    await queryClient
      .fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => Promise.reject(new ApiError('unauthorized', 401)) })
      .catch(() => {})

    expect(navigate).not.toHaveBeenCalled()
  })
})
