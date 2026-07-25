import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Аварийный «толчок» воркера tg-ingest — рестарт контейнера.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Пока постер и воркер делят одну строку сессии (E2E_TG_SESSION не
 * заведён — на аккаунте 2FA, и второй auth-key требует облачный пароль), воркер периодически
 * «залипает»: Telegram отдаёт realtime последнему подключившемуся, update-loop уходит в цикл
 * реконнектов, а `backfillAll()` в ingest.service.ts — single-flight (`backfillInFlight ??= …`),
 * поэтому ОДИН зависший проход блокирует все последующие НАВСЕГДА. Пост при этом лежит в
 * Telegram, но в БД не появляется никогда — до перезапуска воркера (на старте он делает
 * backfillAll и подхватывает всё пропущенное).
 *
 * Это костыль, и он сознательно ограничен режимом общей сессии: с отдельной сессией постера
 * («pnpm e2e session») недоставка означает НАСТОЯЩУЮ проблему, и прятать её рестартом нельзя.
 */
export async function nudgeIngest(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
  await exec('docker', ['compose', 'restart', 'tg-ingest'], { cwd: repoRoot })
}
