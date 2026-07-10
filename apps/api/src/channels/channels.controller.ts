import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common'
import type { ChannelDto, MessageDto } from 'shared/dto.js'
import { ChannelsService, DEFAULT_MESSAGE_LIMIT } from './channels.service.js'

@Controller('channels')
export class ChannelsController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get()
  async list(): Promise<ChannelDto[]> {
    return this.channels.listChannels()
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number): Promise<ChannelDto> {
    const channel = await this.channels.getChannel(id)
    if (!channel) throw new NotFoundException(`Канал ${id} не найден`)
    return channel
  }

  @Get(':id/messages')
  async messages(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limitRaw?: string,
    @Query('before') beforeRaw?: string,
  ): Promise<MessageDto[]> {
    const limit = Number(limitRaw)
    // Некорректные limit/before (не число) молча откатываются к дефолту/«без фильтра», а не
    // улетают в SQL как NaN — иначе `tg_message_id < NaN` падает 500 вместо разумного ответа.
    const before = Number(beforeRaw)
    return this.channels.listMessages(
      id,
      limitRaw !== undefined && Number.isFinite(limit) ? limit : DEFAULT_MESSAGE_LIMIT,
      beforeRaw !== undefined && Number.isFinite(before) ? before : undefined,
    )
  }
}
