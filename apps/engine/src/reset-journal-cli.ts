// CLI разовой чистки торгового журнала: `pnpm journal:reset` (корневой package.json ->
// scripts/reset-journal.mjs -> `node --import tsx src/reset-journal-cli.ts` с cwd=apps/engine —
// тот же приём, что и cleanup-dryrun-cli.ts/channel-keys-cli.ts).
//
// Вся логика — в state/reset-journal.ts (тестируется против copytrade_test); здесь — разбор
// аргументов, печать сводки и защита от случайного запуска: без `--force` показывается только
// предпросмотр, ничего не меняется.

import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { createDb } from 'api/db/database.js'
import { checkResetGuard, previewResetJournal, resetJournal } from './state/reset-journal.js'

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) })

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('[journal:reset] DATABASE_URL не задан — скопируйте .env.example в .env')
    process.exitCode = 1
    return
  }

  const force = process.argv.slice(2).includes('--force')
  const db = createDb(databaseUrl)
  try {
    const preview = await previewResetJournal(db)
    console.log('Будет удалено:')
    console.log(`  действий (actions):    ${preview.actions}`)
    console.log(`  сделок (trades):       ${preview.trades}`)
    console.log(`  ордеров (orders):      ${preview.orders}`)
    console.log(`  исполнений:            ${preview.executions}`)
    console.log(`  строк зеркала позиций: ${preview.positions}`)
    console.log(`  результатов разбора:   ${preview.parseResults}`)
    console.log(`Сообщений будет помечено archived: ${preview.archivedMessages}`)
    console.log('Сообщения и записи ai_calls (потраченные деньги) НЕ удаляются.')

    const guard = await checkResetGuard(db)
    if (!guard.allowed) {
      console.error(`\n[journal:reset] ОТКАЗ: ${guard.reason}`)
      process.exitCode = 1
      return
    }

    if (!force) {
      console.log('\nЭто предпросмотр. Чтобы применить: pnpm journal:reset --force')
      return
    }

    const summary = await resetJournal(db)
    console.log('\n[journal:reset] журнал очищен.')
    console.log(`  удалено действий: ${summary.actions}, сделок: ${summary.trades}, ордеров: ${summary.orders}`)
    console.log(`  сообщений помечено archived: ${summary.archivedMessages}`)
    console.log('  водяные знаки каналов (разбираются только сообщения НОВЕЕ):')
    for (const mark of summary.watermarks) {
      console.log(`    канал ${mark.channelId}: > ${mark.processFromMessageId}`)
    }
  } finally {
    await db.destroy()
  }
}

// Автозапуск ТОЛЬКО как entrypoint (тот же приём, что в main.ts): тесты импортируют логику из
// state/reset-journal.ts, а не отсюда, но случайный импорт не должен ничего чистить.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[journal:reset] неожиданная ошибка:', err)
    process.exitCode = 1
  })
}
