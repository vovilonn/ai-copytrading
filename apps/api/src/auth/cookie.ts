import type { CookieOptions } from 'express'

// Имя и время жизни куки сессии — единая точка правды для контроллера (login/logout) и гварда.
export const SESSION_COOKIE = 'session'
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60 // 7 дней — совпадает со сроком жизни JWT

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // secure только в проде: локальный dev и тесты идут по http, cookie с secure там браузер/агент
    // просто не отправит обратно.
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SEC * 1000,
  }
}
