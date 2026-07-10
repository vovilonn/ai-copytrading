import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { FileMigrationProvider, Migrator, type Kysely } from 'kysely'
import { createDb } from './database.js'

const migrationFolder = fileURLToPath(new URL('./migrations', import.meta.url))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Migrator в kysely типизирован как Kysely<any>
function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  })
}

// Экспортируется отдельно от CLI: тест (`test/migration.test.ts`) вызывает эту функцию напрямую.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = createMigrator(db)
  const { error, results } = await migrator.migrateToLatest()

  for (const r of results ?? []) {
    if (r.status === 'Success') {
      console.log(`миграция "${r.migrationName}" применена`)
    } else if (r.status === 'Error') {
      console.error(`миграция "${r.migrationName}" упала`)
    }
  }

  if (error) {
    console.error('migrateToLatest завершился с ошибкой', error)
    throw error
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function migrateDown(db: Kysely<any>): Promise<void> {
  const migrator = createMigrator(db)
  const { error, results } = await migrator.migrateDown()

  for (const r of results ?? []) {
    if (r.status === 'Success') {
      console.log(`миграция "${r.migrationName}" откачена`)
    } else if (r.status === 'Error') {
      console.error(`откат "${r.migrationName}" упал`)
    }
  }

  if (error) {
    console.error('migrateDown завершился с ошибкой', error)
    throw error
  }
}

// CLI: `tsx src/db/migrate.ts up|down`
async function main(): Promise<void> {
  // CLI запускается из корня репозитория (`pnpm --filter api migrate:up`), но .env лежит в корне —
  // process.env его сам не подхватывает, поэтому грузим явно (аналогично vitest.config.ts).
  config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) })

  const direction = process.argv[2]
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL не задан')

  const db = createDb(databaseUrl)
  try {
    if (direction === 'down') {
      await migrateDown(db)
    } else {
      await migrateToLatest(db)
    }
  } finally {
    await db.destroy()
  }
}

// Запускаем main() только при прямом вызове файла (CLI), не при импорте из теста.
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
