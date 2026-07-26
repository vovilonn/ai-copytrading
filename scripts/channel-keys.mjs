import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Тонкая обёртка CLI субаккаунтов Bybit по каналам (docs/superpowers/specs/
// 2026-07-26-per-channel-subaccounts-design.md §2). Реальная логика — TypeScript в движке
// (apps/engine/src/channel-keys-cli.ts -> bybit/channel-keys.ts), его нельзя импортировать
// напрямую из корневого .mjs (workspace-пакеты api/shared резолвятся только из node_modules
// движка) — тот же приём, что и scripts/cleanup-dryrun-positions.mjs: запускаем через
// `node --import tsx` с cwd=apps/engine.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const engineDir = join(repoRoot, 'apps', 'engine')

const child = spawn(process.execPath, ['--import', 'tsx', 'src/channel-keys-cli.ts', ...process.argv.slice(2)], {
  cwd: engineDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
