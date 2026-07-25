/**
 * `pnpm tg:chats` — печатает все каналы/группы, доступные аккаунту юзербота, с их «сырыми» id.
 *
 * Нужен для тестового режима: id вашего тестового канала неоткуда взять, а Telegram в UI его не
 * показывает. Отсюда берётся значение для TG_CHANNEL_OVERRIDES (см. .env.example).
 *
 * ВАЖНО про id: Telegram отдаёт каналы с префиксом -100 (например -1002088626562), но в БД и в
 * CHANNEL_SOURCES живёт «сырой» id (2088626562). Скрипт печатает СЫРОЙ — его и подставляйте.
 */
import { createClient } from './lib/tg.mjs'

const client = createClient()
await client.connect()

if (!(await client.isUserAuthorized())) {
  console.error('Сессия не авторизована. Сначала: pnpm tg:login')
  process.exit(1)
}

// Под каким аккаунтом работает юзербот — именно ЕГО надо добавлять в тестовый канал.
// Частая ошибка: канал создан личным аккаунтом, а слушает его другой (тот, чья сессия в TG_SESSION),
// и он туда не приглашён — канал просто не появляется в диалогах, и бот его «не видит».
const me = await client.getMe()
const meName = [me.firstName, me.lastName].filter(Boolean).join(' ')
console.log(
  `\nЮзербот работает под аккаунтом: ${meName}${me.username ? ` (@${me.username})` : ''}${me.phone ? `, +${me.phone}` : ''}`,
)
console.log('Именно этот аккаунт нужно добавить в ваш тестовый канал.')

// limit 500 не хватает: у активного аккаунта диалогов больше, и каналы (broadcast) просто не
// попадали в выборку — список выглядел так, будто у аккаунта нет ни одного канала.
const dialogs = await client.getDialogs({ limit: 1000 })

const rows = []
for (const dialog of dialogs) {
  const entity = dialog.entity
  if (!entity || !('id' in entity)) continue

  const className = entity.className // Channel | Chat | User
  if (className === 'User') continue // личные переписки не источники сигналов

  const isForum = 'forum' in entity && entity.forum === true
  const isBroadcast = 'broadcast' in entity && entity.broadcast === true
  const isCreator = 'creator' in entity && entity.creator === true
  const isAdmin = 'adminRights' in entity && Boolean(entity.adminRights)

  rows.push({
    id: entity.id.toString(), // GramJS отдаёт уже сырой id (без -100)
    title: ('title' in entity ? entity.title : null) ?? '(без названия)',
    kind: isForum ? 'форум' : isBroadcast ? 'канал' : 'группа',
    handle: 'username' in entity && entity.username ? `@${entity.username}` : '',
    role: isCreator ? 'ВАШ (создатель)' : isAdmin ? 'админ' : '',
    rank: isCreator ? 0 : isAdmin ? 1 : 2,
  })
}

if (rows.length === 0) {
  console.log('\nУ аккаунта нет каналов/групп. Создайте тестовый канал и добавьте в него этот аккаунт.')
  process.exit(0)
}

// Тестовый канал вы создаёте сами → вы его creator. Показываем такие первыми, чтобы не искать
// нужную строку среди сотни чужих чатов.
rows.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))

const width = (key, min) => Math.max(min, ...rows.map((r) => String(r[key]).length))
const wId = width('id', 4)
const wTitle = Math.min(40, width('title', 8))
const wKind = width('kind', 6)

const own = rows.filter((r) => r.rank < 2)
console.log(`\nВсего чатов: ${rows.length}. Из них ваших (создатель/админ): ${own.length}.\n`)
console.log(`  ${'ID'.padEnd(wId)}  ${'ТИП'.padEnd(wKind)}  ${'НАЗВАНИЕ'.padEnd(wTitle)}  РОЛЬ`)
console.log(`  ${'-'.repeat(wId)}  ${'-'.repeat(wKind)}  ${'-'.repeat(wTitle)}  ----`)
for (const r of rows) {
  const title = r.title.length > wTitle ? `${r.title.slice(0, wTitle - 1)}…` : r.title
  console.log(`  ${r.id.padEnd(wId)}  ${r.kind.padEnd(wKind)}  ${title.padEnd(wTitle)}  ${r.role}${r.handle ? `  ${r.handle}` : ''}`)
}

console.log(`
Как использовать (тестовый режим):

  1) Создайте 1-2 своих канала (или группы) и добавьте туда аккаунт юзербота.
  2) Возьмите ID из таблицы выше и впишите в .env:

       TG_CHANNEL_OVERRIDES=1=<ID первого>,2=<ID второго>

     где 1 = канал со структурными сигналами (regex-парсер ch1-structured),
         2 = канал со свободным текстом (AI-парсер ch2-freeform).
     Можно подменить только один: TG_CHANNEL_OVERRIDES=1=<ID>

  3) Перезапустите стек:  docker compose up -d --build tg-ingest api engine

  ⚠️ Пока оверрайд включён, БОЕВЫЕ каналы НЕ слушаются — сигналы оттуда не торгуются.
`)

await client.disconnect()
await client.destroy()
