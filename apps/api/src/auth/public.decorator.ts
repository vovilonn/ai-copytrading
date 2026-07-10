import { SetMetadata } from '@nestjs/common'

// Помечает роут как открытый для JwtGuard, который иначе применяется глобально ко всем
// эндпоинтам (см. app.module.ts, APP_GUARD). В Ф0 единственный публичный роут — POST /auth/login.
export const IS_PUBLIC_KEY = 'isPublic'
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)
