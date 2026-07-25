import { existsSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Корень медиа-хранилища. Раньше каждый потребитель вычислял его сам как «N уровней вверх от
 * import.meta.url» (tg-ingest — 3, api и engine — 4) в расчёте на структуру репозитория
 * apps/<name>/src/... Прод-образ ломает это допущение: `pnpm deploy --prod` сплющивает пруненое
 * замыкание, и код оказывается в /app/src/... — те же «3 уровня вверх» уводят уже за пределы /app,
 * в корень ФС. Медиа молча писалось в несуществующий /var/media и терялось.
 *
 * Поэтому корень задаётся ЯВНО через MEDIA_ROOT (docker-compose: /app/var/media), а вычисляемый
 * дефолт остаётся только для dev/тестов, где структура репозитория гарантирована: ищем вверх от
 * cwd каталог с pnpm-workspace.yaml (процессы стартуют из apps/<name>, тесты — тоже).
 */
export function resolveMediaRoot(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit)

  let dir = process.cwd()
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, 'var', 'media')
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(process.cwd(), 'var', 'media')
}

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  EXECUTION_MODE: z.enum(['dry_run', 'live']),
  TG_APP_API_ID: z.coerce.number().int().positive(),
  TG_APP_API_HASH: z.string().min(1),
  TG_SESSION: z.string().min(1),
  // Активная сеть Bybit (задача 1, Ф1; 'demo' добавлен в p3-task6-demo): выбирает хост
  // testnet/mainnet/demo для публичных market-эндпоинтов (instruments-info, risk-limit) — см.
  // instruments.service.ts. 'demo' — Bybit DEMO TRADING (api-demo.bybit.com), НЕ testnet.
  BYBIT_NETWORK: z.enum(['testnet', 'mainnet', 'demo']).default('testnet'),
  // Абсолютный путь к каталогу медиа (см. resolveMediaRoot выше). Не задан ИЛИ пустая строка
  // (`MEDIA_ROOT=` в .env — так он и лежит в .env.example) — вычисляем от корня воркспейса;
  // в контейнерах задаётся явно, потому что там структура каталогов другая.
  MEDIA_ROOT: z.string().optional(),
})

export type AppConfig = {
  databaseUrl: string; jwtSecret: string
  adminUsername: string; adminPassword: string
  executionMode: 'dry_run' | 'live'
  tgApiId: number; tgApiHash: string; tgSession: string
  bybitNetwork: 'testnet' | 'mainnet' | 'demo'
  /** Абсолютный путь к var/media. В БД (message_media.storage_path) путь остаётся ОТНОСИТЕЛЬНЫМ
   *  ('var/media/<key>/<file>') — потребители снимают префикс и резолвят остаток от этого корня. */
  mediaRoot: string
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const r = schema.safeParse(env)
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')
    throw new Error(`Некорректная конфигурация:\n  ${issues}`)
  }
  const e = r.data
  return {
    databaseUrl: e.DATABASE_URL, jwtSecret: e.JWT_SECRET,
    adminUsername: e.ADMIN_USERNAME, adminPassword: e.ADMIN_PASSWORD,
    executionMode: e.EXECUTION_MODE,
    tgApiId: e.TG_APP_API_ID, tgApiHash: e.TG_APP_API_HASH, tgSession: e.TG_SESSION,
    bybitNetwork: e.BYBIT_NETWORK,
    mediaRoot: resolveMediaRoot(e.MEDIA_ROOT),
  }
}
