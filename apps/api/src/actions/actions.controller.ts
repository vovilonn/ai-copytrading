import { Controller, Get, Inject, Query } from '@nestjs/common'
import type { ActionRowDto } from 'shared/dto.js'
import { ActionsService } from './actions.service.js'

@Controller('actions')
export class ActionsController {
  constructor(@Inject(ActionsService) private readonly actions: ActionsService) {}

  @Get()
  async list(
    @Query('channel') channel?: string,
    @Query('period') period?: string,
    @Query('type') type?: string,
    @Query('side') side?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<ActionRowDto[]> {
    return this.actions.listActions({ channel, period, type, side, q, limit, before })
  }
}
