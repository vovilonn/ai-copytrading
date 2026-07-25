import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { ChannelsModule } from '../channels/channels.module.js'
import { ConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { OutboxPublisher } from './outbox.publisher.js'
import { RealtimeGateway } from './realtime.gateway.js'

// ChannelsModule — outbox обогащает событие 'message.processed' от движка: тот знает только id
// сообщения, а собрать узел таймлайна (альбом/медиа/действия/саммари) умеет ChannelsService.
@Module({
  imports: [ConfigModule, DbModule, AuthModule, ChannelsModule],
  providers: [RealtimeGateway, OutboxPublisher],
})
export class RealtimeModule {}
