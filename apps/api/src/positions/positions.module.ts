import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { PositionsController } from './positions.controller.js'
import { PositionsService } from './positions.service.js'

@Module({
  imports: [DbModule],
  controllers: [PositionsController],
  providers: [PositionsService],
})
export class PositionsModule {}
