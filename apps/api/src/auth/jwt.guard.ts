import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AuthService } from './auth.service.js'
import { SESSION_COOKIE } from './cookie.js'
import { IS_PUBLIC_KEY } from './public.decorator.js'

/** Глобальный гвард (см. app.module.ts, APP_GUARD): закрывает все роуты, кроме помеченных @Public(). */
@Injectable()
export class JwtGuard implements CanActivate {
  // Явные @Inject(...) на обоих параметрах — см. комментарий в auth.service.ts про
  // design:paramtypes под vitest/esbuild.
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const req = context.switchToHttp().getRequest<Request>()
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined
    if (!token) throw new UnauthorizedException()

    try {
      req.user = await this.auth.verifyToken(token)
      return true
    } catch {
      // Просроченный/подделанный/сорванный токен — тот же 401, что и при отсутствии куки.
      throw new UnauthorizedException()
    }
  }
}
