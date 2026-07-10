import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { createDb } from './db/database.js'
import { migrateToLatest } from './db/migrate.js'

// .env лежит в корне репозитория, process.env его не подхватывает сам — грузим явно и
// обязательно ДО динамического import('./app.js') ниже: тот тянет AppModule → ConfigModule,
// который читает process.env синхронно в момент импорта модуля (тот же приём и та же причина,
// что и в packages/test-db/src/global-setup.ts — статический import слинковался бы раньше,
// чем отработает loadDotenv, и DATABASE_URL/JWT_SECRET были бы не видны).
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL не задан')

  // Миграции — отдельным короткоживущим подключением; приложение поднимет свой пул через DbModule.
  const migrationDb = createDb(databaseUrl)
  try {
    await migrateToLatest(migrationDb)
  } finally {
    await migrationDb.destroy()
  }

  const { createApp } = await import('./app.js')
  const app = await createApp()
  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
  console.log(`[api] сервер запущен на :${port}`)
}

main().catch((err) => {
  console.error('[api] фатальная ошибка при старте:', err)
  process.exitCode = 1
})
