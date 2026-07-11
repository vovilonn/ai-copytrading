import { QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from './api.js'

/**
 * Общая фабрика QueryClient (вынесена из main.tsx, финальное ревью Ф1, Important #4) — ловит
 * протухшую сессию ГЛОБАЛЬНО, а не только на первом рендере через RequireAuth/RedirectIfAuthed
 * (lib/components/auth-guard.tsx). До этого фикса: если кука истекала МЕЖДУ навигациями (не на
 * самом первом заходе), apiFetch (lib/api.ts) бросал ApiError(401), но actions.tsx/positions.tsx
 * читали `data ?? []` — 401 неотличим от пустого списка, пользователь видел "No … match the
 * filters" вместо намёка перелогиниться.
 *
 * queryCache.onError триггерится на любой упавший запрос ЛЮБОЙ страницы — на 401 сбрасываем кэш
 * ['auth','me'] (RequireAuth перерисуется как неавторизованный без лишнего перезапроса) и уводим
 * на /login. `navigate` инжектируется параметром — в main.tsx это `router.navigate` (createBrowserRouter
 * отдаёт объект роутера с этим методом, вызывать можно и вне React-дерева), в тестах — vi.fn()-шпион.
 *
 * query.queryKey[0] !== 'auth' — не нужно тоже самое действие на 401 от самого /auth/me: тот
 * случай (незалогинен с самого начала) уже штатно обрабатывает RequireAuth/RedirectIfAuthed
 * через `!data`, лишний navigate('/login') здесь просто не добавляет вреда, но и не нужен.
 */
export function createQueryClient(navigate: (to: string) => void): QueryClient {
  const queryClient = new QueryClient({
    // retry:false — 401 это штатное «не авторизован»/«сессия протухла», а не сбой сети,
    // незачем ретраить его с бэк-оффом (иначе редирект на /login подвиснет на секунды).
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== 'auth') {
          // removeQueries, а не setQueryData(key, undefined) — TanStack Query игнорирует
          // setQueryData с явным undefined как значением (трактует как "не обновлять", не как
          // "очистить"), реального сброса кэша так не получить.
          queryClient.removeQueries({ queryKey: ['auth', 'me'] })
          navigate('/login')
        }
      },
    }),
  })
  return queryClient
}
