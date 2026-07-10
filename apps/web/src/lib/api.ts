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

// Обёртка над fetch для всех запросов к API: всегда шлёт куку сессии (credentials:
// 'include' — API и фронт на разных портах в деве, прокси Vite их сшивает), бросает
// ApiError на не-2xx вместо тихого возврата, сама разбирает JSON (204 → undefined).
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(path, { ...init, credentials: 'include', headers })
  if (!res.ok) {
    throw new ApiError(`${init.method ?? 'GET'} ${path} failed: ${res.status}`, res.status)
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
