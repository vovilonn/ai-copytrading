import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config/config.schema.js'

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret123',
  EXECUTION_MODE: 'dry_run',
  TG_APP_API_ID: '12345',
  TG_APP_API_HASH: 'abc',
  TG_SESSION: 'sess',
}

it('принимает валидный env', () => {
  expect(loadConfig(valid).executionMode).toBe('dry_run')
})

it('падает, если JWT_SECRET короче 32 символов', () => {
  expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/)
})

it('падает на неизвестном EXECUTION_MODE', () => {
  expect(() => loadConfig({ ...valid, EXECUTION_MODE: 'yolo' })).toThrow(/EXECUTION_MODE/)
})
