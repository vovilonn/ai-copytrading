import { Module } from '@nestjs/common'
import { loadConfig } from './config.schema.js'

export const APP_CONFIG = Symbol('APP_CONFIG')

@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useValue: loadConfig(process.env),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
