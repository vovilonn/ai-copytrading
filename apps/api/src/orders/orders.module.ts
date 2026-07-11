import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { PendingOrdersController } from './pending.controller.js'
import { PendingOrdersService } from './pending.service.js'

@Module({
  imports: [DbModule],
  controllers: [PendingOrdersController],
  providers: [PendingOrdersService],
})
export class OrdersModule {}
