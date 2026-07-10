export interface AuthenticatedUser {
  sub: string // users.id
  username: string
}

// Дополняем Express.Request полем user, которое JwtGuard проставляет после успешной проверки
// JWT — без этого контроллеры видели бы req.user как unknown и требовали бы каст в каждом месте.
// Глобальная декларация (а не `declare module 'express-serve-static-core'`) — этот пакет
// доступен только транзитивно через @types/express и не резолвится напрямую из apps/api
// (pnpm изолирует транзитивные зависимости); global-augmentation — стандартный приём для этого
// случая (так же типизирует req.user, например, @types/passport).
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
    }
  }
}
