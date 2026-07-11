import { cn } from '../lib/utils.js'

interface TableStateRowProps {
  /** TanStack Query `isPending` — первая загрузка (без закэшированных данных ещё). */
  isPending: boolean
  /** TanStack Query `isError` — запрос упал (401/500/сеть). До фикса (финальное ревью Ф1,
   *  Important #4) actions.tsx/positions.tsx читали только `data ?? []`, и сбой рисовался как
   *  обычное пустое состояние — неотличимо от "правда нет строк под фильтром". */
  isError: boolean
  /** true, когда запрос успешно завершился, но строк нет — единственный случай, когда уместно
   *  сообщение "No … match the filters", а не "Loading…"/ошибка. */
  isEmpty: boolean
  emptyMessage: string
  errorMessage?: string
}

/** Общая строка-подвал таблицы (Actions/Positions) — загрузка/ошибка/пусто. Рендерит null, если
 *  ни одно из трёх состояний не активно (есть строки — их рисует сама таблица). */
export function TableStateRow({ isPending, isError, isEmpty, emptyMessage, errorMessage }: TableStateRowProps) {
  if (!isPending && !isError && !isEmpty) return null

  const text = isPending ? 'Loading…' : isError ? (errorMessage ?? 'Something went wrong. Please try again.') : emptyMessage

  return (
    <div className="border-t border-row-border px-[22px] py-8 text-center">
      <span className={cn('text-[13px]', isError ? 'text-short' : 'text-muted-1')}>{text}</span>
    </div>
  )
}
