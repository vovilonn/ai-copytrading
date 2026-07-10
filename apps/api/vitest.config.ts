import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { defineConfig } from 'vitest/config'

// Vitest не читает .env сам — подгружаем корневой .env до запуска тестов,
// чтобы DATABASE_URL и прочие переменные были видны в process.env.
// fileURLToPath (не .pathname) — иначе путь с пробелами/юникодом останется percent-encoded.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

export default defineConfig({
  test: {
    environment: 'node',
    // FileMigrationProvider делает динамический import() файлов миграций (.ts) из node_modules/kysely;
    // без инлайна kysely этот import попадает в нативный загрузчик Node и не умеет резолвить .ts.
    server: {
      deps: {
        inline: ['kysely'],
      },
    },
  },
})
