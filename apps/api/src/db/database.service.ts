import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/config.schema.js'
import { createDb, type DB } from './database.js'

/**
 * Обёртка над Kysely-подключением для DI: создаётся один раз на процесс Nest-приложения
 * (провайдер — синглтон по умолчанию) и закрывает пул на onModuleDestroy (вызывается
 * автоматически на app.close(), в т.ч. в тестах — без этого supertest-прогоны текли бы pg-пулами).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Kysely<DB>

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.db = createDb(config.databaseUrl)
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy()
  }
}
