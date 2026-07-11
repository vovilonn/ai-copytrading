import { Controller, Get, Inject } from '@nestjs/common'
import type { PendingOrderDto } from 'shared/dto.js'
import { PendingOrdersService } from './pending.service.js'

// JwtGuard закрывает роут глобально (APP_GUARD в app.module.ts) — тот же приём, что и у
// ChannelSettingsController/PositionsController, отдельный контроллер под свой ресурс.
@Controller('orders')
export class PendingOrdersController {
  constructor(@Inject(PendingOrdersService) private readonly pending: PendingOrdersService) {}

  @Get('pending')
  async list(): Promise<PendingOrderDto[]> {
    return this.pending.listPending()
  }
}
