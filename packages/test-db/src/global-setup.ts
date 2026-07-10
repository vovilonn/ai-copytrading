import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

// Подключается как test.globalSetup в vitest.config.ts обоих пакетов (api, tg-ingest):
// выполняется один раз перед всеми тестами, в отдельном от воркеров процессе.
export default async function setup(): Promise<void> {
  // globalSetup не наследует dotenv-инициализацию воркеров (setup-env.ts) — грузим .env
  // здесь тоже, иначе DATABASE_URL не виден и ensureTestDatabase() упадёт.
  config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

  // Динамический import(), а не статический: index.ts вычисляет TEST_DATABASE_URL
  // в момент импорта модуля, а статические импорты линкуются раньше, чем выполнится
  // config() выше — DATABASE_URL тогда ещё не был бы виден.
  const { ensureTestDatabase } = await import('./index.js')
  await ensureTestDatabase()
}
