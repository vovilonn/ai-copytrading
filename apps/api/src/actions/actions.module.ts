import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { ActionsController } from './actions.controller.js'
import { ActionsService } from './actions.service.js'

@Module({
  imports: [DbModule],
  controllers: [ActionsController],
  providers: [ActionsService],
})
export class ActionsModule {}
