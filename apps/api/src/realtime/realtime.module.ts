import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { ConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { OutboxPublisher } from './outbox.publisher.js'
import { RealtimeGateway } from './realtime.gateway.js'

@Module({
  imports: [ConfigModule, DbModule, AuthModule],
  providers: [RealtimeGateway, OutboxPublisher],
})
export class RealtimeModule {}
