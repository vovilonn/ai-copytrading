import { it, expect } from 'vitest'
import { resetTestSchema } from 'test-db'
import { createDb } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { loadConfig } from 'api/config/config.schema.js'
import { IngestService } from '../src/ingest.service.js'

// Реальное read-only подключение к Telegram: сообщения не отправляем, сессию не инвалидируем.
// Без TG_SESSION в окружении (root .env) тест пропускается, а не падает.
const hasSession = Boolean(process.env.TG_SESSION)

// Страховка от одиночного отклонённого keepalive-пинга GramJS (§5 research-дока) — не должен
// уронить прогон теста.
process.on('unhandledRejection', (reason) => {
  console.error('[ingest.smoke] unhandledRejection:', reason)
})

it.skipIf(!hasSession)(
  'видит оба источника и фильтрует топик',
  async () => {
    const config = loadConfig(process.env)
    const db = createDb(config.databaseUrl)
    await migrateToLatest(db)
    // Чистим тестовую БД до сида: connect() ниже засевает реальные каналы с ord=1,2, а
    // repository.test.ts в том же прогоне (одна БД, fileParallelism:false) оставляет свой
    // канал с ord=1 — без сброса UNIQUE(ord) конфликтует в зависимости от порядка файлов.
    await resetTestSchema(db)

    const service = new IngestService(config, db)
    try {
      await service.connect()
      const forum = await service.probeTopic(1962583820n, 173666, 5)
      expect(forum.length).toBeGreaterThan(0)
      expect(forum.every((m) => m.topicKind !== 'other')).toBe(true)
    } finally {
      await service.stop()
      await db.destroy()
    }
  },
  60_000,
)
