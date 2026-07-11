import { Controller, Get, Inject, Query } from '@nestjs/common'
import type { ChannelPnlDto, ClosedTradeDto, PositionDto, PositionStatsDto } from 'shared/dto.js'
import { PositionsService } from './positions.service.js'

@Controller('positions')
export class PositionsController {
  constructor(@Inject(PositionsService) private readonly positions: PositionsService) {}

  // Статичные пути /positions/stats(/by-channel) и /positions/history объявлены раньше корневого
  // GET — по значению это не важно для Nest (у корневого маршрута нет динамического :id, с которым
  // они могли бы конфликтовать), но так порядок читается так же, как в дизайне (сначала карточки
  // статистики, потом таблицы open/closed).
  @Get('stats')
  async stats(): Promise<PositionStatsDto> {
    return this.positions.getStats()
  }

  @Get('stats/by-channel')
  async statsByChannel(): Promise<ChannelPnlDto[]> {
    return this.positions.getStatsByChannel()
  }

  @Get('history')
  async history(
    @Query('channel') channel?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<ClosedTradeDto[]> {
    return this.positions.listClosedTrades({ channel, status, limit, before })
  }

  @Get()
  async list(
    @Query('channel') channel?: string,
    @Query('side') side?: string,
    @Query('margin') margin?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<PositionDto[]> {
    return this.positions.listPositions({ channel, side, margin, q, limit, before })
  }
}
