import path from 'node:path'
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

it('BYBIT_NETWORK не задан -> дефолт testnet', () => {
  expect(loadConfig(valid).bybitNetwork).toBe('testnet')
})

it('падает на невалидном BYBIT_NETWORK', () => {
  expect(() => loadConfig({ ...valid, BYBIT_NETWORK: 'mars' })).toThrow(/BYBIT_NETWORK/)
})

// Регрессия: раньше каждый потребитель считал корень медиа как «N уровней вверх от import.meta.url»
// (tg-ingest — 3, api/engine — 4). В прод-образе `pnpm deploy --prod` сплющивает apps/<name>/src → src,
// корень уезжал за пределы /app в корень ФС — медиа молча писалось в /var/media и терялось.
describe('mediaRoot', () => {
  it('MEDIA_ROOT задан -> берётся как есть (абсолютным)', () => {
    expect(loadConfig({ ...valid, MEDIA_ROOT: '/app/var/media' }).mediaRoot).toBe('/app/var/media')
  })

  it('MEDIA_ROOT пустой (так лежит в .env.example) -> дефолт от корня воркспейса, не падение', () => {
    const root = loadConfig({ ...valid, MEDIA_ROOT: '' }).mediaRoot
    expect(root).toMatch(/var[/\\]media$/)
    expect(path.isAbsolute(root)).toBe(true)
  })

  it('MEDIA_ROOT не задан -> дефолт от корня воркспейса', () => {
    const root = loadConfig(valid).mediaRoot
    expect(root).toMatch(/var[/\\]media$/)
    expect(path.isAbsolute(root)).toBe(true)
  })
})
