import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../src/routes/login.js'
import { apiFetch, ApiError } from '../src/lib/api.js'

// apiFetch замокан целиком — тест проверяет только поведение формы (валидация,
// редирект, обработка ошибки), не реальную сеть.
vi.mock('../src/lib/api.js', () => {
  class MockApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return { apiFetch: vi.fn(), ApiError: MockApiError }
})

function renderLogin() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Обычный (не data-) роутер: createMemoryRouter/RouterProvider в jsdom падают на
  // конструировании internal Request/AbortSignal при navigate() — несовместимость
  // jsdom с undici, не связанная с логикой самого компонента. MemoryRouter+Routes
  // этот код-путь не задействует и достаточен для проверки редиректа.
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/channels" element={<div>Channels page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('пустые поля показывают "Enter your login and password"', async () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter your login and password')).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('успешный вход редиректит на /channels', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined)
    renderLogin()
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Channels page')).toBeInTheDocument()
  })

  it('неверный пароль показывает ошибку', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError('unauthorized', 401))
    renderLogin()
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid login or password')).toBeInTheDocument()
  })
})
