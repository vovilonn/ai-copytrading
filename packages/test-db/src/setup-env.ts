import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

// Подключается как test.setupFiles в vitest.config.ts обоих пакетов (api, tg-ingest):
// выполняется в контексте воркера перед импортом самих тестовых файлов, поэтому
// подмена DATABASE_URL здесь успевает подействовать до createDb()/loadConfig() в тестах.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

// Динамический import(), а не статический: index.ts вычисляет TEST_DATABASE_URL в момент
// импорта модуля из process.env.DATABASE_URL — статический import был бы слинкован (и
// выполнен) раньше, чем отработает config() выше, и упал бы с «DATABASE_URL не задан».
const { TEST_DATABASE_URL } = await import('./index.js')

process.env.DATABASE_URL = TEST_DATABASE_URL
