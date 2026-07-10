import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Стандартный shadcn/ui хелпер: clsx собирает условные классы, twMerge убирает
// конфликтующие дубли (например 'px-2 px-4' → 'px-4') при переопределении через className.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
