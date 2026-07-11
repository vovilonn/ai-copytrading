import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { PositionsController } from './positions.controller.js'
import { PositionsService } from './positions.service.js'

@Module({
  imports: [DbModule],
  controllers: [PositionsController],
  providers: [PositionsService],
  // WalletModule (GET /account/wallet) переиспользует getStatsByChannel — экспортируем сервис,
  // чтобы не дублировать per-channel SQL (Task 2).
  exports: [PositionsService],
})
export class PositionsModule {}
