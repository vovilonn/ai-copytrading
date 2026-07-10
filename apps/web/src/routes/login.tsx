import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { ApiError, apiFetch } from '../lib/api.js'

// Экран входа 1:1 с Admin.dc.html:43-68.
export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  async function submit() {
    // Валидация пустых полей — до сети, как и в оригинале (login() в DC-скрипте).
    if (!username.trim() || !password.trim()) {
      setError('Enter your login and password')
      return
    }
    setPending(true)
    setError('')
    try {
      await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      // /auth/me теперь ответит 200 — сбрасываем кэш, чтобы гарды сразу увидели авторизацию.
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      navigate('/channels', { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Invalid login or password'
          : 'Something went wrong, try again',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex w-full max-w-[360px] flex-col gap-6">
        <div className="flex items-center justify-center gap-3">
          <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-accent">
            <div className="h-3 w-3 rounded-[3px] bg-black" />
          </div>
          <span className="text-lg font-semibold tracking-[-0.01em] text-fg">CopyTrade AI</span>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border border-white/[.08] bg-card px-6 py-[26px]">
          <div>
            <h1 className="m-0 mb-1 text-lg font-semibold text-fg">Sign in</h1>
            <p className="m-0 text-[13px] text-muted-1">Access your copy-trading control panel</p>
          </div>

          <div className="flex flex-col gap-[7px]">
            <label htmlFor="login-username" className="text-xs font-medium text-secondary-3">
              Login
            </label>
            <Input
              id="login-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              autoComplete="username"
            />
          </div>

          <div className="flex flex-col gap-[7px]">
            <label htmlFor="login-password" className="text-xs font-medium text-secondary-3">
              Password
            </label>
            <Input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {error ? <span className="m-0 text-[12.5px] text-short">{error}</span> : null}

          <Button className="mt-0.5" disabled={pending} onClick={() => void submit()}>
            Sign in
          </Button>
        </div>
      </div>
    </div>
  )
}
