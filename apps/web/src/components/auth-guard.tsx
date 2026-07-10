import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/api.js'

// Пока не пришёл ответ GET /auth/me — не показываем ни защищённый контент, ни экран логина,
// чтобы не мигал неправильный экран при обновлении страницы.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuth()
  if (isLoading) return null
  if (!data) return <Navigate to="/login" replace />
  return <>{children}</>
}

// Обратный гард для /login: уже залогиненного пользователя не пускаем на экран входа.
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { data, isLoading } = useAuth()
  if (isLoading) return null
  if (data) return <Navigate to="/channels" replace />
  return <>{children}</>
}
