import { Module } from '@nestjs/common'
import { ConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'

// JwtGuard регистрируется отдельно как глобальный APP_GUARD в app.module.ts (нужен всем
// контроллерам, не только auth) — здесь достаточно экспортировать AuthService, от которого
// он зависит.
@Module({
  imports: [ConfigModule, DbModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
