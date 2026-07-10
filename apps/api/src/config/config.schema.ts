import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  EXECUTION_MODE: z.enum(['dry_run', 'live']),
  TG_APP_API_ID: z.coerce.number().int().positive(),
  TG_APP_API_HASH: z.string().min(1),
  TG_SESSION: z.string().min(1),
})

export type AppConfig = {
  databaseUrl: string; jwtSecret: string
  adminUsername: string; adminPassword: string
  executionMode: 'dry_run' | 'live'
  tgApiId: number; tgApiHash: string; tgSession: string
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
  }
}
