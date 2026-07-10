import crypto from 'node:crypto'
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/config.schema.js'
import { DatabaseService } from '../db/database.service.js'
import { SESSION_TTL_SEC } from './cookie.js'
import type { AuthenticatedUser } from './request-user.js'

const BCRYPT_ROUNDS = 10

export interface UserRecord {
  id: string
  username: string
  role: string
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name)
  private readonly secret: Uint8Array

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Явный @Inject(DatabaseService), а не только type-based DI: vitest/esbuild не гарантированно
    // эмитит design:paramtypes для декораторов (в отличие от tsc), а второй параметр без явного
    // токена в этом случае резолвится в undefined без ошибки — падение всплывает не в DI, а
    // позже, на первом обращении к this.database.db.
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {
    this.secret = new TextEncoder().encode(config.jwtSecret)
  }

  /** Сидирует админа при старте приложения — идемпотентно (бриф задачи 7). */
  async onModuleInit(): Promise<void> {
    await this.seedAdmin()
  }

  private async seedAdmin(): Promise<void> {
    const { adminUsername, adminPassword } = this.config
    const existing = await this.database.db
      .selectFrom('users')
      .select(['id', 'password_hash'])
      .where('username', '=', adminUsername)
      .executeTakeFirst()

    if (!existing) {
      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS)
      const now = new Date()
      // users в DB-типах (database.ts) не обёрнут в Generated<>, хотя id/created_at/updated_at
      // имеют DEFAULT в схеме — Kysely в этом случае требует все поля явно (тот же приём, что и
      // у channels/channel_settings в apps/tg-ingest/src/ingest.service.ts).
      await this.database.db
        .insertInto('users')
        .values({
          id: crypto.randomUUID(),
          username: adminUsername,
          password_hash: passwordHash,
          role: 'admin',
          created_at: now,
          updated_at: now,
        })
        .execute()
      this.logger.log(`создан админ "${adminUsername}"`)
      return
    }

    // Идемпотентность: bcrypt.hash одного и того же пароля каждый раз даёт разную соль/хеш,
    // поэтому перезаписываем password_hash ТОЛЬКО если пароль реально сменился в .env —
    // иначе повторный старт с тем же ADMIN_PASSWORD менял бы хеш без необходимости.
    const passwordUnchanged = await bcrypt.compare(adminPassword, existing.password_hash)
    if (!passwordUnchanged) {
      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS)
      await this.database.db
        .updateTable('users')
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where('id', '=', existing.id)
        .execute()
      this.logger.log(`обновлён пароль админа "${adminUsername}"`)
    }
  }

  /** Возвращает пользователя при верном логине/пароле, иначе null. */
  async validateCredentials(username: string, password: string): Promise<UserRecord | null> {
    const user = await this.database.db
      .selectFrom('users')
      .select(['id', 'username', 'password_hash', 'role'])
      .where('username', '=', username)
      .executeTakeFirst()
    if (!user) return null

    const ok = await bcrypt.compare(password, user.password_hash)
    return ok ? { id: user.id, username: user.username, role: user.role } : null
  }

  async signToken(user: UserRecord): Promise<string> {
    return new SignJWT({ username: user.username, role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SEC}s`)
      .sign(this.secret)
  }

  /** Кидает исключение jose (JWTExpired/JWSInvalid/...) — обрабатывается в JwtGuard. */
  async verifyToken(token: string): Promise<AuthenticatedUser> {
    const { payload } = await jwtVerify(token, this.secret)
    return { sub: String(payload.sub), username: String(payload.username) }
  }
}
