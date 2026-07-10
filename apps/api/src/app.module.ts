import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthModule } from './auth/auth.module.js'
import { JwtGuard } from './auth/jwt.guard.js'
import { ChannelsModule } from './channels/channels.module.js'
import { ConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'

@Module({
  imports: [ConfigModule, DbModule, AuthModule, ChannelsModule],
  providers: [
    // Все роуты закрыты JwtGuard, кроме помеченных @Public() (сейчас — только POST /auth/login).
    { provide: APP_GUARD, useClass: JwtGuard },
  ],
})
export class AppModule {}
