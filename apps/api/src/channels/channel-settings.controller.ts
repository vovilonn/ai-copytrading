import { Body, Controller, Inject, Param, ParseIntPipe, Patch } from '@nestjs/common'
import type { ChannelSettingsDto } from 'shared/dto.js'
import { ChannelSettingsService, type UpdateChannelSettingsInput } from './channel-settings.service.js'

// Отдельный контроллер (а не метод в ChannelsController) — держит Settings-таб (задача Ф4)
// изолированно от чтения каналов/сообщений, как и просит бриф (channel-settings.controller.ts +
// service отдельным файлом). JwtGuard закрывает роут глобально (app.module.ts, APP_GUARD).
@Controller('channels')
export class ChannelSettingsController {
  constructor(@Inject(ChannelSettingsService) private readonly settings: ChannelSettingsService) {}

  @Patch(':id/settings')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateChannelSettingsInput,
  ): Promise<ChannelSettingsDto> {
    return this.settings.update(id, body)
  }
}
