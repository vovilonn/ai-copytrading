// CLI разовой чистки фантомных dry_run позиций (задача 3, план
// docs/superpowers/plans/2026-07-12-monitoring-pnl-balance.md, Task 3/Task 5). Запускается через
// `pnpm cleanup:dryrun` (корневой package.json) -> `scripts/cleanup-dryrun-positions.mjs` ->
// `node --import tsx src/cleanup-dryrun-cli.ts` с cwd=apps/engine (тот же приём, что и
// scripts/backtest.mjs -> backtest/cli.ts) — только так резолвятся workspace-пакеты api/shared и
// зависимости движка (pg/kysely) без плоского `node` в корне репозитория.
//
// Вся логика — в `state/cleanup-dryrun.ts::cleanupDryRunPositions` (чистая, тестируемая функция
// против copytrade_test, см. test/cleanup-dryrun.test.ts); этот файл — только подключение к БД,
// вызов и печать отчёта.

import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { createDb } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import { cleanupDryRunPositions } from './state/cleanup-dryrun.js'

// .env лежит в корне репозитория — тот же приём, что main.ts/backtest/cli.ts.
loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[cleanup-dryrun] DATABASE_URL не задан — скопируйте .env.example в .env')
    process.exitCode = 1
    return
  }

  const db = createDb(databaseUrl)
  try {
    // Защитно (main.ts делает то же самое на каждом старте движка): скрипт может быть запущен
    // против БД, где ещё не применена последняя миграция — migrateToLatest идемпотентна.
    await migrateToLatest(db)

    const report = await cleanupDryRunPositions(db)

    console.log('[cleanup-dryrun] отчёт (всё выполнено в одной транзакции — либо целиком, либо ничего):')
    console.log(`  сделок закрыто (open/partially_closed -> closed): ${report.tradesClosed}`)
    console.log(`  позиций обнулено (positions.size -> 0):           ${report.positionsZeroed}`)
    console.log(`  символов освобождено (symbol_ownership):          ${report.ownershipReleased}`)
    console.log(`  ордеров отменено (-> cancelled):                  ${report.ordersCancelled}`)

    if (report.tradesClosed === 0) {
      console.log('[cleanup-dryrun] открытых dry_run сделок не найдено — уже чисто (идемпотентный повторный запуск).')
    }
  } finally {
    await db.destroy()
  }
}

main().catch((err) => {
  console.error('[cleanup-dryrun] фатальная ошибка:', err)
  process.exitCode = 1
})
