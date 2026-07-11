import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Тонкая обёртка CLI разовой чистки фантомных dry_run позиций (задача 3, план
// docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md, Task 3/Task 5: "перед первым
// live-стартом — разовая чистка 76 фантомных dry_run позиций"). Реальная логика — TypeScript в
// движке (apps/engine/src/cleanup-dryrun-cli.ts -> state/cleanup-dryrun.ts), его нельзя
// импортировать напрямую из корневого .mjs (workspace-пакеты api/shared резолвятся только из
// node_modules движка) — тот же приём, что и scripts/backtest.mjs: запускаем через
// `node --import tsx` с cwd=apps/engine, где резолвятся и tsx, и pg/kysely/api/shared.
// .env уже загружен корневым `node --env-file-if-exists=.env` (см. package.json) и наследуется,
// а cleanup-dryrun-cli.ts на всякий случай грузит его сам ещё раз (тот же приём, что и main.ts).

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const engineDir = join(repoRoot, 'apps', 'engine')

const child = spawn(process.execPath, ['--import', 'tsx', 'src/cleanup-dryrun-cli.ts', ...process.argv.slice(2)], {
  cwd: engineDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
