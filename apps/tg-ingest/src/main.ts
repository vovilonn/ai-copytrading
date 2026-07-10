import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from 'api/config/config.schema.js'
import { createDb } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { IngestService } from './ingest.service.js'

// Запускается из apps/tg-ingest (pnpm --filter tg-ingest dev), а .env лежит в корне репозитория —
// process.env его сам не подхватывает (тот же приём, что и apps/api/src/db/migrate.ts).
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const db = createDb(config.databaseUrl)
  await migrateToLatest(db)

  const service = new IngestService(config, db)
  await service.connect()
  await service.start()
  console.log('[tg-ingest] воркер запущен: реалтайм + бэкфилл активны')

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[tg-ingest] получен ${signal}, завершаюсь...`)
    service
      .stop()
      .then(() => db.destroy())
      .then(() => {
        console.log('[tg-ingest] остановлен корректно')
        process.exit(0)
      })
      .catch((err) => {
        console.error('[tg-ingest] ошибка при остановке:', err)
        process.exit(1)
      })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Одиночный отклонённый keepalive-пинг GramJS не должен ронять процесс (§5) — логируем и живём дальше.
process.on('unhandledRejection', (reason) => {
  console.error('[tg-ingest] unhandledRejection:', reason)
})

main().catch((err) => {
  console.error('[tg-ingest] фатальная ошибка при старте:', err)
  process.exitCode = 1
})
