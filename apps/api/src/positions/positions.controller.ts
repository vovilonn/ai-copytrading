import { Controller, Get, Inject, Query } from '@nestjs/common'
import type { PositionDto, PositionStatsDto } from 'shared/dto.js'
import { PositionsService } from './positions.service.js'

@Controller('positions')
export class PositionsController {
  constructor(@Inject(PositionsService) private readonly positions: PositionsService) {}

  // Статичный путь /positions/stats объявлен раньше корневого GET — по значению это не важно
  // для Nest (у корневого маршрута нет динамического :id, с которым 'stats' могла бы конфликтовать),
  // но так порядок читается так же, как в дизайне (сначала карточки статистики, потом таблица).
  @Get('stats')
  async stats(): Promise<PositionStatsDto> {
    return this.positions.getStats()
  }

  @Get()
  async list(
    @Query('channel') channel?: string,
    @Query('side') side?: string,
    @Query('margin') margin?: string,
    @Query('q') q?: string,
  ): Promise<PositionDto[]> {
    return this.positions.listPositions({ channel, side, margin, q })
  }
}
