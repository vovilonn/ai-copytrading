import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Тонкая обёртка CLI разовой правки отложенного входа (действия/сделки/ордера + перевод уже
// подтянутой истории в статус archived). Реальная логика — TypeScript в движке
// (apps/engine/src/amend-entry-cli.ts -> state/reset-journal.ts), его нельзя импортировать
// напрямую из корневого .mjs (workspace-пакеты api/shared резолвятся только из node_modules
// движка) — тот же приём, что и scripts/cleanup-dryrun-positions.mjs.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const engineDir = join(repoRoot, 'apps', 'engine')

const child = spawn(process.execPath, ['--import', 'tsx', 'src/amend-entry-cli.ts', ...process.argv.slice(2)], {
  cwd: engineDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
