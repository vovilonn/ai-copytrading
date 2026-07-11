import { cn } from '../lib/utils.js'

interface LoadMoreProps {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  /** Класс контейнера — геометрия отличается: таймлайн вешает pl-[50px]/pb под вертикальную
   *  линию (MessageTimeline), таблицы центрируют кнопку под собой без отступа. */
  className?: string
}

// Кнопка «Load more» — вынесена из components/MessageTimeline.tsx (обоснование там же: загрузка
// по клику, а не по скроллу — детерминированно, без IntersectionObserver, который нетривиально
// мокать в jsdom-тестах). Стиль кнопки 1:1 с оригиналом таймлайна.
export function LoadMore({ hasNextPage, isFetchingNextPage, onLoadMore, className }: LoadMoreProps) {
  if (!hasNextPage) return null
  return (
    <div className={cn('flex justify-center', className)}>
      <button
        type="button"
        onClick={onLoadMore}
        disabled={isFetchingNextPage}
        className="cursor-pointer rounded-md border border-white/10 bg-transparent px-4 py-2 font-sans text-[12.5px] font-medium text-secondary-2 hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isFetchingNextPage ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}
