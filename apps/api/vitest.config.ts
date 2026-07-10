import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Один раз перед всеми тестами файла: создаёт БД copytrade_test на сервере из
    // DATABASE_URL, если её ещё нет (см. packages/test-db/src/global-setup.ts).
    globalSetup: ['test-db/global-setup'],
    // Перед импортом каждого тестового файла подменяет process.env.DATABASE_URL на
    // TEST_DATABASE_URL — createDb(process.env.DATABASE_URL!) в тестах смотрит на
    // изолированную тестовую базу, а не на рабочую dev-базу (см. packages/test-db).
    setupFiles: ['test-db/setup-env'],
    // Несколько файлов тестов (migration.test.ts, auth.e2e.test.ts, channels.e2e.test.ts) пишут
    // в одни и те же таблицы одной тестовой БД и каждый чистит её через resetTestSchema в своём
    // beforeAll — параллельные файлы гонялись бы за TRUNCATE и ломали фикстуры друг друга
    // (тот же приём, что и apps/tg-ingest/vitest.config.ts).
    fileParallelism: false,
    // FileMigrationProvider делает динамический import() файлов миграций (.ts) из node_modules/kysely;
    // без инлайна kysely этот import попадает в нативный загрузчик Node и не умеет резолвить .ts.
    server: {
      deps: {
        inline: ['kysely'],
      },
    },
  },
})
