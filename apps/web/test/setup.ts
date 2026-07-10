import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

// globals:false в vitest.config.ts — testing-library не видит afterEach на globalThis
// и не регистрирует автоочистку DOM сама, поэтому размонтируем предыдущий рендер вручную,
// иначе второй/третий тест в файле видит узлы обоих рендеров разом.
afterEach(() => {
  cleanup()
})
