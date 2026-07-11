import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { PositionsModule } from '../positions/positions.module.js'
import { WalletController } from './wallet.controller.js'
import { WalletService } from './wallet.service.js'

// PositionsModule экспортирует PositionsService — WalletService переиспользует getStatsByChannel
// для perChannel (не дублируем per-channel SQL, Task 2).
@Module({
  imports: [DbModule, PositionsModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
