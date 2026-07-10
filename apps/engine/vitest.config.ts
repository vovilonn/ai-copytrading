import { defineConfig } from 'vitest/config'

// engine — в основном пакет чистых функций парсинга (числа/нормализация/резолвер символов),
// но задача 5 добавила state/trades.ts — работу с БД (trades/trade_legs/symbol_ownership).
// Поэтому, как и apps/tg-ingest/apps/api, здесь теперь нужен globalSetup/setupFiles на
// test-db (см. packages/test-db) — тесты trades.test.ts идут против реальной copytrade_test.
export default defineConfig({
  test: {
    environment: 'node',
    // Один раз перед всеми тестами: создаёт БД copytrade_test из DATABASE_URL, если её нет.
    globalSetup: ['test-db/global-setup'],
    // Подменяет process.env.DATABASE_URL на TEST_DATABASE_URL до импорта тестовых файлов.
    setupFiles: ['test-db/setup-env'],
    // trades.test.ts чистит схему через resetTestSchema в своём beforeAll — при будущем
    // росте числа DB-тестовых файлов (задача 6: dry-run.adapter.test.ts) параллельные файлы
    // гонялись бы за один и тот же TRUNCATE (тот же приём, что и в tg-ingest/api).
    fileParallelism: false,
    // FileMigrationProvider делает динамический import() .ts-файлов миграций из node_modules/kysely —
    // без инлайна kysely этот import не резолвится нативным загрузчиком Node.
    server: {
      deps: {
        inline: ['kysely'],
      },
    },
  },
})
