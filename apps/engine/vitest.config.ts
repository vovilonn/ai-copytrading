import { defineConfig } from 'vitest/config'

// engine — пакет чистых функций парсинга (числа/нормализация/резолвер символов):
// без сети и БД, поэтому в отличие от apps/tg-ingest и apps/api здесь нет
// globalSetup/setupFiles на test-db и нет .env — тестам просто нечего подключать.
export default defineConfig({
  test: {
    environment: 'node',
  },
})
