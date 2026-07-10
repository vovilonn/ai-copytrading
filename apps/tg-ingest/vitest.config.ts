import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'vitest/config'

// repository.test.ts — интеграционный тест против живого Postgres, читает DATABASE_URL
// из корневого .env (см. apps/api/vitest.config.ts — тот же приём).
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

export default defineConfig({
  test: {
    environment: 'node',
    // FileMigrationProvider делает динамический import() .ts-файлов миграций из node_modules/kysely;
    // без инлайна kysely этот import попадает в нативный загрузчик Node и не умеет резолвить .ts.
    server: {
      deps: {
        inline: ['kysely'],
      },
    },
  },
})
