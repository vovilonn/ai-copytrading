import { defineConfig } from 'vitest/config'

// Чистые функции без сети и БД — dotenv здесь не нужен.
export default defineConfig({
  test: {
    environment: 'node',
  },
})
