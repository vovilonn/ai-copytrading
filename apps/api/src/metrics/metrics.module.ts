import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.js'
import { MetricsController } from './metrics.controller.js'
import { MetricsService } from './metrics.service.js'

@Module({
  imports: [DbModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
