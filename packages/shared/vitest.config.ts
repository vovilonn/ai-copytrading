import { defineConfig } from 'vitest/config'

// shared — общие типы и чистые утилиты (числа и т.д.): без сети и БД,
// поэтому здесь нет globalSetup/setupFiles на test-db, как в apps/tg-ingest.
export default defineConfig({
  test: {
    environment: 'node',
  },
})
