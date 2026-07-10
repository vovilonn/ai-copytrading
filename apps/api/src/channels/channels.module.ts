import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { ChannelSeedService } from './channel-seed.service.js'
import { ChannelsController } from './channels.controller.js'
import { ChannelsService } from './channels.service.js'
import { MediaController } from './media.controller.js'

@Module({
  imports: [DbModule],
  controllers: [ChannelsController, MediaController],
  providers: [ChannelsService, ChannelSeedService],
})
export class ChannelsModule {}
