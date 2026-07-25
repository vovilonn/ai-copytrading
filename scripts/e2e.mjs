import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Тонкая обёртка CLI e2e-петли. Реальная логика — TypeScript в apps/e2e: импортировать его
// напрямую из корневого .mjs нельзя (workspace-пакеты api/shared/engine резолвятся только из
// node_modules самого пакета), поэтому запускаем через `node --import tsx` с cwd=apps/e2e —
// там резолвятся и tsx, и telegram/pg/kysely/api/shared/engine. Тот же приём, что и у
// scripts/backtest.mjs / scripts/cleanup-dryrun-positions.mjs.
// .env уже загружен корневым `node --env-file-if-exists=.env` (см. package.json) и наследуется,
// а env.ts на всякий случай грузит его сам ещё раз (прямой запуск `tsx src/cli.ts`).

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const e2eDir = join(repoRoot, 'apps', 'e2e')

const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...process.argv.slice(2)], {
  cwd: e2eDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
