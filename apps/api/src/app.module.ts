import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ActionsModule } from './actions/actions.module.js'
import { AuthModule } from './auth/auth.module.js'
import { JwtGuard } from './auth/jwt.guard.js'
import { ChannelsModule } from './channels/channels.module.js'
import { ConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { InstrumentsModule } from './instruments/instruments.module.js'
import { PositionsModule } from './positions/positions.module.js'
import { RealtimeModule } from './realtime/realtime.module.js'

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AuthModule,
    ChannelsModule,
    InstrumentsModule,
    ActionsModule,
    PositionsModule,
    RealtimeModule,
    HealthModule,
  ],
  providers: [
    // Все роуты закрыты JwtGuard, кроме помеченных @Public() (сейчас — только POST /auth/login).
    { provide: APP_GUARD, useClass: JwtGuard },
  ],
})
export class AppModule {}
