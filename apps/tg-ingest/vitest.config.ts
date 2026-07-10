import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Один раз перед всеми тестами файла: создаёт БД copytrade_test на сервере из
    // DATABASE_URL, если её ещё нет (см. packages/test-db/src/global-setup.ts).
    globalSetup: ['test-db/global-setup'],
    // Перед импортом каждого тестового файла подменяет process.env.DATABASE_URL на
    // TEST_DATABASE_URL — createDb(process.env.DATABASE_URL!)/loadConfig() в тестах
    // смотрят на изолированную тестовую базу, а не на рабочую dev-базу (см. packages/test-db).
    setupFiles: ['test-db/setup-env'],
    // Несколько файлов тестов пишут в одни и те же таблицы одной тестовой БД (repository.test.ts,
    // ingest.smoke.test.ts): параллельные файлы гонялись бы за один UNIQUE(ord) и друг друга ломали.
    fileParallelism: false,
    // FileMigrationProvider делает динамический import() .ts-файлов миграций из node_modules/kysely;
    // без инлайна kysely этот import попадает в нативный загрузчик Node и не умеет резолвить .ts.
    server: {
      deps: {
        inline: ['kysely'],
      },
    },
  },
})
