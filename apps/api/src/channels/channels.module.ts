import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { ChannelSeedService } from './channel-seed.service.js'
import { ChannelSettingsController } from './channel-settings.controller.js'
import { ChannelSettingsService } from './channel-settings.service.js'
import { ChannelsController } from './channels.controller.js'
import { ChannelsService } from './channels.service.js'
import { MediaController } from './media.controller.js'
import { ChannelStatsService } from './stats.service.js'

@Module({
  imports: [DbModule],
  controllers: [ChannelsController, ChannelSettingsController, MediaController],
  providers: [ChannelsService, ChannelSettingsService, ChannelSeedService, ChannelStatsService],
  // RealtimeModule (outbox.publisher.ts) пересобирает узел таймлайна по событию 'message.processed'
  // от движка — сборка MessageDto живёт здесь, дублировать её в realtime нельзя.
  exports: [ChannelsService],
})
export class ChannelsModule {}
