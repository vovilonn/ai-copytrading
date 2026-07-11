import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ScheduleModule } from '@nestjs/schedule'
import { ActionsModule } from './actions/actions.module.js'
import { AuthModule } from './auth/auth.module.js'
import { JwtGuard } from './auth/jwt.guard.js'
import { ChannelsModule } from './channels/channels.module.js'
import { ConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { InstrumentsModule } from './instruments/instruments.module.js'
import { MetricsModule } from './metrics/metrics.module.js'
import { OrdersModule } from './orders/orders.module.js'
import { PositionsModule } from './positions/positions.module.js'
import { RealtimeModule } from './realtime/realtime.module.js'
import { WalletModule } from './wallet/wallet.module.js'

@Module({
  imports: [
    ConfigModule,
    DbModule,
    // ScheduleModule.forRoot() — регистрируется один раз в корне: без него @Interval()
    // в InstrumentsService (периодический refresh() кэша инструментов, Important #1
    // финального ревью Ф1) не подхватится SchedulerRegistry — декоратор молча ничего не делает.
    ScheduleModule.forRoot(),
    AuthModule,
    ChannelsModule,
    InstrumentsModule,
    ActionsModule,
    PositionsModule,
    OrdersModule,
    RealtimeModule,
    HealthModule,
    MetricsModule,
    WalletModule,
  ],
  providers: [
    // Все роуты закрыты JwtGuard, кроме помеченных @Public() (сейчас — только POST /auth/login).
    { provide: APP_GUARD, useClass: JwtGuard },
  ],
})
export class AppModule {}
