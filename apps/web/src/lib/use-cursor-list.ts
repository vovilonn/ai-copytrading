import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'

/** Курсор keyset-пагинации — id/tradeRef (строка) или tgMessageId (число), см. bare-array
 *  контракт бэкенда (apps/api/src/actions/actions.service.ts, positions.service.ts). */
export type Cursor = string | number

interface UseCursorListOptions<T> {
  queryKey: QueryKey
  /** Загрузка одной страницы: before=undefined — первая, иначе курсор последней строки прошлой. */
  fetchPage: (before: Cursor | undefined) => Promise<T[]>
  /** Курсор для перехода на следующую страницу — поле последней строки текущей (id/tradeRef/…). */
  getCursor: (item: T) => Cursor
  pageSize: number
  enabled?: boolean
}

/**
 * Общий помощник keyset-пагинации («load more»), вынесен из components/MessageTimeline.tsx
 * (единственная готовая infinite-пагинация Ф1) — чтобы Positions/Actions/история закрытых
 * сделок не копипастили один и тот же useInfiniteQuery. Все списки используют одну bare-array
 * конвенцию: страница ровно из `pageSize` строк ⇒ есть ещё (hasNextPage), курсор следующей
 * страницы = поле последней строки (?before=<cursor>), страница короче ⇒ конец.
 *
 * Кэш — InfiniteData<T[]>, той же формы, что useInfiniteQuery отдавал напрямую в MessageTimeline:
 * lib/ws.ts патчит его точечно (message.new/position.upsert), поэтому форма кэша не меняется —
 * реалтайм-инвалидации и патчи продолжают работать поверх пагинации, ничего не ломая.
 */
export function useCursorList<T>({ queryKey, fetchPage, getCursor, pageSize, enabled }: UseCursorListOptions<T>) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }: { pageParam: Cursor | undefined }) => fetchPage(pageParam),
    initialPageParam: undefined as Cursor | undefined,
    getNextPageParam: (lastPage: T[]) => {
      if (lastPage.length < pageSize) return undefined
      const last = lastPage[lastPage.length - 1]
      return last ? getCursor(last) : undefined
    },
    enabled,
  })

  return {
    items: query.data?.pages.flat() ?? [],
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isPending: query.isPending,
    isError: query.isError,
  }
}
