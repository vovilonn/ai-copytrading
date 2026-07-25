import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

// Подключается как test.setupFiles в vitest.config.ts обоих пакетов (api, tg-ingest):
// выполняется в контексте воркера перед импортом самих тестовых файлов, поэтому
// подмена DATABASE_URL здесь успевает подействовать до createDb()/loadConfig() в тестах.
config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

// Тесты гоняют БОЕВУЮ конфигурацию каналов и не должны зависеть от локальной настройки
// разработчика: если в .env включён тестовый режим (TG_CHANNEL_OVERRIDES — свои Telegram-каналы,
// см. shared/sources.ts), сидеры завели бы ДРУГИЕ каналы, а фикстуры сеют сообщения для боевых —
// и весь api-набор падал бы на FK messages_channel_id_fkey. Снимаем оверрайд для тестов.
delete process.env.TG_CHANNEL_OVERRIDES

// Динамический import(), а не статический: index.ts вычисляет TEST_DATABASE_URL в момент
// импорта модуля из process.env.DATABASE_URL — статический import был бы слинкован (и
// выполнен) раньше, чем отработает config() выше, и упал бы с «DATABASE_URL не задан».
const { TEST_DATABASE_URL } = await import('./index.js')

process.env.DATABASE_URL = TEST_DATABASE_URL
