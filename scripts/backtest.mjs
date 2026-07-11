import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Тонкая обёртка CLI бэктеста. Реальная логика — TypeScript в движке
// (apps/engine/src/backtest/cli.ts): его нельзя импортировать напрямую из корневого .mjs
// (workspace-пакеты api/shared резолвятся только из node_modules движка), поэтому запускаем
// его через `node --import tsx` С cwd=apps/engine — там резолвятся и tsx, и pg/kysely/api/shared.
// .env уже загружен корневым `node --env-file-if-exists=.env` (см. package.json) и наследуется.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const engineDir = join(repoRoot, 'apps', 'engine')

const child = spawn(process.execPath, ['--import', 'tsx', 'src/backtest/cli.ts', ...process.argv.slice(2)], {
  cwd: engineDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
