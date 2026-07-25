import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.js'
import { SESSION_COOKIE, sessionCookieOptions } from './cookie.js'
import { Public } from './public.decorator.js'

interface LoginBody {
  username?: unknown
  password?: unknown
}

@Controller('auth')
export class AuthController {
  // @Inject явный: см. комментарий в auth.service.ts про design:paramtypes под vitest/esbuild.
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(204)
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      throw new UnauthorizedException('Invalid username or password')
    }

    const user = await this.auth.validateCredentials(body.username, body.password)
    if (!user) throw new UnauthorizedException('Invalid username or password')

    const token = await this.auth.signToken(user)
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions())
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions())
  }

  @Get('me')
  me(@Req() req: Request): { username: string } {
    // JwtGuard (глобальный) гарантирует req.user к этому моменту — иначе запрос не дошёл бы сюда.
    return { username: req.user!.username }
  }
}
