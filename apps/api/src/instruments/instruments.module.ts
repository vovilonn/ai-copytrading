import { Module } from '@nestjs/common'
import { ConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { InstrumentsService } from './instruments.service.js'

@Module({
  imports: [DbModule, ConfigModule],
  providers: [InstrumentsService],
  exports: [InstrumentsService],
})
export class InstrumentsModule {}
