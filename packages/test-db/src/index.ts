import pg from 'pg'
import { sql, type Kysely } from 'kysely'

// Таблицы служебной миграционной инфраструктуры Kysely — не рабочие данные,
// TRUNCATE их не касается (иначе resetTestSchema сотрёт учёт применённых миграций).
const KYSELY_SERVICE_TABLES = new Set(['kysely_migration', 'kysely_migration_lock'])

/**
 * Выводит адрес тестовой БД из DATABASE_URL, подменяя только имя базы данных.
 * Хост/порт/пользователь — те же, что и у рабочей БД: тестам не нужен отдельный
 * сервер Postgres, нужна только отдельная база на нём, чтобы TRUNCATE в тестах
 * не мог задеть dev-данные.
 */
function computeTestDatabaseUrl(): string {
  const base = process.env.DATABASE_URL
  if (!base) {
    throw new Error(
      'DATABASE_URL не задан: тестовая база выводится из рабочего DATABASE_URL подменой ' +
        'имени базы — задайте DATABASE_URL в .env (см. .env.example)',
    )
  }
  const testDbName = process.env.TEST_DATABASE_NAME ?? 'copytrade_test'
  const url = new URL(base)
  url.pathname = `/${testDbName}`
  return url.toString()
}

export const TEST_DATABASE_URL = computeTestDatabaseUrl()

/**
 * Создаёт тестовую БД, если её ещё нет. CREATE DATABASE нельзя выполнить «изнутри»
 * самой создаваемой базы, поэтому подключаемся к служебной базе `postgres` на том же
 * сервере (том же хосте/порту/пользователе, что и TEST_DATABASE_URL).
 */
export async function ensureTestDatabase(): Promise<void> {
  const testUrl = new URL(TEST_DATABASE_URL)
  const dbName = decodeURIComponent(testUrl.pathname.replace(/^\//, ''))

  const adminUrl = new URL(TEST_DATABASE_URL)
  adminUrl.pathname = '/postgres'

  const client = new pg.Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    // Идентификатор нельзя параметризовать в CREATE DATABASE — экранируем вручную
    // (двойные кавычки внутри имени удваиваются, как того требует Postgres).
    const quotedName = `"${dbName.replace(/"/g, '""')}"`
    await client.query(`CREATE DATABASE ${quotedName}`)
  } catch (err) {
    // 42P04 = duplicate_database: база уже создана предыдущим прогоном — это ожидаемо.
    const code = (err as { code?: string }).code
    if (code !== '42P04') throw err
  } finally {
    await client.end()
  }
}

/**
 * Чистит все рабочие таблицы public-схемы перед прогоном тестов. Список таблиц
 * собирается динамически из information_schema.tables, а не хардкодится — иначе
 * список протухнет при добавлении таблиц в Ф1–Ф4.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- переиспользуется api и tg-ingest с разными DB-типами
export async function resetTestSchema(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `.execute(db)

  const tables = rows.map((r) => r.table_name).filter((t) => !KYSELY_SERVICE_TABLES.has(t))
  if (tables.length === 0) return

  await sql`TRUNCATE ${sql.join(tables.map((t) => sql.id(t)))} RESTART IDENTITY CASCADE`.execute(db)
}
