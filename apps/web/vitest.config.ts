import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

// Тесты используют jsdom (нужен DOM для @testing-library/react) и отдельный setup-файл
// с jest-dom матчерами. mergeConfig переиспользует plugins/resolve из vite.config.ts,
// чтобы дев-сервер и тесты резолвили модули одинаково.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      globals: false,
    },
  }),
)
