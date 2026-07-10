import { useQuery } from '@tanstack/react-query'

// Ошибка API с HTTP-статусом — вызывающий код (форма логина и т.п.) может отличить
// 401 от прочих сбоев и показать разное сообщение.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// Весь HTTP API смонтирован под /api (apps/api/src/app.ts, setGlobalPrefix('api') — задача
// 12c): без этого прокси Vite (apps/web/vite.config.ts) не может отличить SPA-роут
// /channels/:id от HTTP-запроса к API при жёсткой перезагрузке страницы. Префикс подклеен
// здесь ОДИН раз — вызывающий код (useAuth, routes/*.tsx, MessageTimeline и т.д.) передаёт
// путь без /api, как и раньше.
const API_PREFIX = '/api'

// Обёртка над fetch для всех запросов к API: всегда шлёт куку сессии (credentials:
// 'include' — API и фронт на разных портах в деве, прокси Vite их сшивает), бросает
// ApiError на не-2xx вместо тихого возврата, сама разбирает JSON (204 → undefined).
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const url = `${API_PREFIX}${path}`
  const res = await fetch(url, { ...init, credentials: 'include', headers })
  if (!res.ok) {
    throw new ApiError(`${init.method ?? 'GET'} ${url} failed: ${res.status}`, res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface Me {
  username: string
}

// Текущий пользователь поверх GET /auth/me. 401 — штатный случай «не залогинен», поэтому
// без ретраев на уровне запроса (глобальный retry:false задан в QueryClient, main.tsx).
export function useAuth() {
  return useQuery<Me>({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<Me>('/auth/me'),
  })
}
