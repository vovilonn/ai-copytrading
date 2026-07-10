# Фаза 0 — Скелет и живая лента — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Оператор логинится в админку и видит живую ленту сообщений обоих Telegram-источников, включая картинки и альбомы.

**Architecture:** pnpm workspace с тремя приложениями (`apps/api`, `apps/tg-ingest`, `apps/web`) и общим `packages/shared`. `tg-ingest` — единственный держатель MTProto-сессии, пишет сообщения в Postgres и публикует `domain_events`. `api` читает БД, отдаёт REST и ретранслирует события в браузер по WebSocket. `web` рисует дизайн 1:1.

**Tech Stack:** Node 22+, pnpm 10, TypeScript, NestJS 11, Postgres 16, Kysely, GramJS (`telegram`), socket.io, React 19 + Vite, Tailwind, shadcn/ui, TanStack Query, Vitest.

**Спека:** `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md`
**Исследования:** `docs/superpowers/research/` (особенно `telegram-ingestion.md`, `frontend-inventory.md`, `backend-architecture.md`)

## Global Constraints

- Node `>=22`, packageManager `pnpm@10.28.1`.
- Все деньги, цены и количества в БД — `NUMERIC`, никогда `float`/`double precision`.
- Порт `8317` занят `ai-proxy` и не переназначается. `api` слушает `3000`, `web` — `5173`, Postgres — `5432`.
- Команды запускаются **из корня репозитория**: внутри `ai-proxy/` лежит свой `docker-compose.yml`, а compose ищет файл вверх по дереву.
- `tg-ingest` работает **ровно в одной реплике**. Две сессии с одним auth-key дают потерю апдейтов и `AUTH_KEY_DUPLICATED`.
- Порядок обработки сообщений — по `message.id`, никогда по `date`.
- Идемпотентность приёма — уникальный ключ `(channel_id, tg_message_id)`.
- Иконки только `lucide-react`. Никаких рисованных вручную SVG (`design/project/CLAUDE.md`).
- Источник правды по дизайну — `design/project/Admin.dc.html`. Скриншоты не открывать (`design/README.md` это прямо запрещает).
- Секреты только в `.env`, который в `.gitignore`. В код и в БД в открытом виде не попадают.

## Design tokens (копировать дословно)

Из `design/project/Admin.dc.html`:

| Токен | Значение |
|---|---|
| фон страницы | `#000000` |
| фон карточки/таблицы | `#0d0d0f` |
| граница | `rgba(255,255,255,.07)` |
| граница строки таблицы | `rgba(255,255,255,.06)` |
| акцент | `#ff6a1f`, hover `#ff8a4d` |
| текст основной | `#fafafa` |
| текст сообщения | `#e4e4e7` |
| текст вторичный | `#c9c9cf`, `#a1a1aa`, `#8a8a90` |
| текст приглушённый | `#6b6b70`, `#5a5a60`, `#4a4a50` |
| long / успех | `#34d399` |
| short / ошибка | `#fb7185` |
| skipped | `#fbbf24` (фон `rgba(251,191,36,.13)`) |
| шрифт | `Exo 2`, файлы в `design/project/uploads/Exo_2/` |
| моно | `ui-monospace, Menlo, monospace` |
| радиус карточки | `10px`; кнопки/инпута — `7px`–`8px` |
| высота сайдбара/топбара | `60px`; ширина сайдбара `246px` |

---

## File Structure

```
package.json                      # workspace root, скрипты
pnpm-workspace.yaml
tsconfig.base.json
docker-compose.yml                # + postgres, api, web (ai-proxy уже есть)

packages/shared/
  src/index.ts                    # ре-экспорт
  src/dto.ts                      # Channel, Message, MessageMedia (общие типы api↔web)
  src/ws-events.ts                # имена и payload'ы WS-событий

apps/api/
  src/main.ts                     # bootstrap, cookie-parser, CORS
  src/app.module.ts
  src/config/config.schema.ts     # zod-схема env
  src/config/config.module.ts
  src/db/database.ts              # Kysely instance + типы таблиц
  src/db/db.module.ts
  src/db/migrations/001_initial.ts
  src/auth/auth.module.ts
  src/auth/auth.service.ts        # bcrypt, seed админа из .env
  src/auth/auth.controller.ts     # POST /auth/login, /auth/logout, GET /auth/me
  src/auth/jwt.guard.ts
  src/channels/channels.module.ts
  src/channels/channels.service.ts
  src/channels/channels.controller.ts   # GET /channels, GET /channels/:id, GET /channels/:id/messages
  src/realtime/realtime.module.ts
  src/realtime/realtime.gateway.ts      # socket.io, guard по JWT-куке
  src/realtime/outbox.publisher.ts      # LISTEN domain_events → broadcast

apps/tg-ingest/
  src/main.ts
  src/topic-filter.ts             # чистая функция topicOf()
  src/album-buffer.ts             # чистый класс AlbumBuffer
  src/media.ts                    # выбор фото/thumbnail
  src/ingest.service.ts           # GramJS клиент, хэндлеры, backfill
  src/repository.ts               # persist + dedup + курсор

apps/web/
  index.html
  vite.config.ts
  tailwind.config.ts              # design tokens
  src/main.tsx
  src/lib/api.ts                  # fetch-клиент
  src/lib/ws.ts                   # socket.io клиент
  src/routes/login.tsx
  src/routes/layout.tsx           # Sidebar + Topbar + BottomNav + Breadcrumbs
  src/routes/channels.tsx
  src/routes/channel.tsx          # табы Messages | Settings (Settings — заглушка до Ф1)
  src/components/MessageTimeline.tsx
  src/components/ui/*             # shadcn
```

---

### Task 1: Монорепо, Postgres, каркас команд

**Files:**
- Modify: `package.json`, `docker-compose.yml`, `.env.example`, `.gitignore`
- Create: `pnpm-workspace.yaml`, `tsconfig.base.json`

**Interfaces:**
- Produces: рабочие `pnpm db:up`, `pnpm db:down`; переменная `DATABASE_URL`.

- [ ] **Step 1: Инициализировать git (репозиторий ещё не создан)**

```bash
cd /Users/vovilonn/Documents/work/work/bybit-copytrade-bot
git init
git add -A && git commit -m "chore: baseline (ai-proxy, scripts, design, docs)"
```

- [ ] **Step 2: Создать `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Создать `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Добавить postgres в корневой `docker-compose.yml`**

Добавить сервис (не трогая `ai-proxy`):

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: bybit-copytrade-db
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-copytrade}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?not set — скопируйте .env.example в .env}
      POSTGRES_DB: ${POSTGRES_DB:-copytrade}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-copytrade} -d ${POSTGRES_DB:-copytrade}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  postgres-data:
```

- [ ] **Step 5: Дописать `.env.example`**

```
# Postgres
POSTGRES_USER=copytrade
POSTGRES_PASSWORD=
POSTGRES_DB=copytrade
DATABASE_URL=postgresql://copytrade:@127.0.0.1:5432/copytrade

# Админка
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
JWT_SECRET=

# Режим исполнения: dry_run | live
EXECUTION_MODE=dry_run
```

- [ ] **Step 6: Добавить скрипты в корневой `package.json`**

```json
"db:up": "docker compose up -d postgres",
"db:down": "docker compose stop postgres",
"db:psql": "docker compose exec postgres psql -U copytrade -d copytrade"
```

- [ ] **Step 7: Проверить, что Postgres поднимается**

Run: `pnpm db:up && sleep 6 && docker compose ps --format 'table {{.Name}}\t{{.Status}}'`
Expected: `bybit-copytrade-db` в статусе `Up ... (healthy)`

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json docker-compose.yml .env.example package.json
git commit -m "chore: pnpm workspace + postgres"
```

---

### Task 2: Полная схема БД (миграция)

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/db/database.ts`, `apps/api/src/db/migrations/001_initial.ts`, `apps/api/src/db/migrate.ts`
- Test: `apps/api/test/migration.test.ts`

**Interfaces:**
- Produces: `export interface DB { ... }` (типы таблиц Kysely), `createDb(url: string): Kysely<DB>`, `pnpm --filter api migrate:up`.

Схема — из `docs/superpowers/research/backend-architecture.md` §2 с четырьмя правками под решение о субаккаунтах:

1. `channels` получает `bybit_sub_uid BIGINT`, `bybit_api_key_enc TEXT`, `bybit_api_secret_enc TEXT`;
2. `channel_settings.equity_share_pct` заменяется на `cross_margin BOOLEAN NOT NULL DEFAULT true` — режим маржи реален, потому что у канала свой субаккаунт;
3. `symbol_ownership` уникален по `(channel_id, symbol)`, а не по `symbol`;
4. `positions` имеет составной первичный ключ `(channel_id, symbol)`.

Плюс поля, вскрытые верификацией: `messages.reply_to_top_id`, `messages.is_topic_message`, `messages.ai_summary`, `messages.edited_ts`.

- [ ] **Step 1: Написать падающий тест миграции**

`apps/api/test/migration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Kysely, sql } from 'kysely'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'

let db: Kysely<DB>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
})
afterAll(async () => { await db.destroy() })

it('создаёт все таблицы схемы', async () => {
  const { rows } = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `.execute(db)
  const names = rows.map((r) => r.table_name)
  for (const t of [
    'users', 'channels', 'channel_settings', 'messages', 'message_media',
    'processed_messages', 'parse_results', 'ai_calls', 'ai_cache', 'actions',
    'trades', 'trade_legs', 'orders', 'executions', 'symbol_ownership',
    'positions', 'instruments', 'domain_events', 'audit_log', 'app_state',
  ]) expect(names).toContain(t)
})

it('запрещает два сообщения с одним tg_message_id в канале', async () => {
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (1, 1, 'test', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  const ins = sql`INSERT INTO messages (channel_id, tg_message_id, msg_ts, raw)
                  VALUES (1, 100, now(), '{}'::jsonb)`
  await ins.execute(db)
  await expect(ins.execute(db)).rejects.toThrow(/duplicate key/)
})

it('разрешает двум каналам владеть одним символом', async () => {
  // субаккаунт на канал ⇒ владение уникально по (channel_id, symbol)
  await sql`INSERT INTO channels (id, ord, key, source_kind, adapter_id)
            VALUES (2, 2, 'test2', 'channel', 'x') ON CONFLICT DO NOTHING`.execute(db)
  const trade = async (ch: number) => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO trades (human_ref, seq, channel_id, symbol, side)
      VALUES ('TR-' || nextval('trade_ref_seq'), nextval('trade_ref_seq'), ${ch}, 'SOLUSDT', 'long')
      RETURNING id`.execute(db)
    return rows[0]!.id
  }
  const own = (ch: number, tid: string) => sql`
    INSERT INTO symbol_ownership (symbol, channel_id, trade_id) VALUES ('SOLUSDT', ${ch}, ${tid})`.execute(db)
  await own(1, await trade(1))
  await expect(own(2, await trade(2))).resolves.toBeDefined()
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `pnpm --filter api test migration`
Expected: FAIL — модуль `../src/db/database.js` не найден.

- [ ] **Step 3: Создать `apps/api/package.json`**

```json
{
  "name": "api",
  "private": true,
  "type": "module",
  "scripts": {
    "migrate:up": "tsx src/db/migrate.ts up",
    "test": "vitest run"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/platform-socket.io": "^11.0.0",
    "@nestjs/websockets": "^11.0.0",
    "bcryptjs": "^3.0.2",
    "cookie-parser": "^1.4.7",
    "jose": "^6.0.0",
    "kysely": "^0.28.0",
    "pg": "^8.13.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "socket.io": "^4.8.1",
    "zod": "^4.0.0"
  },
  "devDependencies": { "tsx": "^4.19.0", "vitest": "^3.0.0", "typescript": "^5.7.0" }
}
```

- [ ] **Step 4: Написать `apps/api/src/db/database.ts`**

Типы таблиц Kysely для всех сущностей схемы плюс фабрика:

```ts
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'

// NUMERIC приходит строкой — оставляем строкой и парсим Decimal'ом в домене,
// иначе теряем точность на ценах.
export interface DB {
  users: { id: string; username: string; password_hash: string; role: string }
  channels: {
    id: number; ord: number; key: string; source_kind: 'channel' | 'forum_topic'
    topic_id: number | null; adapter_id: string; title: string | null; handle: string | null
    status: 'active' | 'paused' | 'error'; last_seen_message_id: number
    bybit_sub_uid: number | null; bybit_api_key_enc: string | null; bybit_api_secret_enc: string | null
  }
  messages: {
    id: string; channel_id: number; tg_message_id: number; topic_id: number | null
    grouped_id: string | null; reply_to_msg_id: number | null; reply_to_top_id: number | null
    is_topic_message: boolean; text: string; normalized_text: string | null
    has_media: boolean; media_kind: string | null; msg_ts: Date
    edit_count: number; edited_ts: Date | null; deleted: boolean
    status: string; ai_summary: string | null; raw: unknown
  }
  message_media: {
    id: string; message_id: string; tg_message_id: number; grouped_id: string | null
    order_index: number; storage_path: string; media_type: string
    width: number | null; height: number | null; bytes: number | null; sha256: string | null
  }
  domain_events: { id: number; type: string; aggregate: string; aggregate_id: string | null; payload: unknown; published_at: Date | null }
  // остальные таблицы схемы объявляются здесь же по мере использования в Ф1–Ф4
}

export function createDb(url: string): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }) })
}
```

- [ ] **Step 5: Написать миграцию `001_initial.ts`**

Скопировать DDL из `docs/superpowers/research/backend-architecture.md` §2 целиком в `sql\`...\`.execute(db)`, применив четыре правки под субаккаунты (перечислены выше) и добавив колонки `reply_to_top_id`, `is_topic_message`, `ai_summary`, `edited_ts` в `messages`.

Критичные фрагменты, отличающиеся от исследования:

```sql
ALTER TABLE channels
  ADD COLUMN bybit_sub_uid BIGINT,
  ADD COLUMN bybit_api_key_enc TEXT,
  ADD COLUMN bybit_api_secret_enc TEXT;

-- вместо equity_share_pct: у канала свой субаккаунт, режим маржи настоящий
ALTER TABLE channel_settings
  ADD COLUMN cross_margin BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE messages
  ADD COLUMN reply_to_top_id BIGINT,
  ADD COLUMN is_topic_message BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_summary TEXT;

-- владение символом — внутри канала, а не глобально
DROP INDEX IF EXISTS uq_symbol_active;
CREATE UNIQUE INDEX uq_symbol_active_per_channel
  ON symbol_ownership (channel_id, symbol) WHERE released_at IS NULL;

-- у каждого канала свой субаккаунт ⇒ своя позиция по символу
ALTER TABLE positions DROP CONSTRAINT positions_pkey;
ALTER TABLE positions ADD PRIMARY KEY (channel_id, symbol);
```

Дефолт `channel_settings.no_sl_policy` — `'attach_protective_sl'` (решение заказчика), CHECK расширить этим значением.

- [ ] **Step 6: Написать раннер `apps/api/src/db/migrate.ts`** (`Migrator` из Kysely, `FileMigrationProvider`).

- [ ] **Step 7: Прогнать миграцию и тест**

Run: `pnpm db:up && pnpm --filter api migrate:up && pnpm --filter api test`
Expected: PASS — все три теста зелёные.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat(db): полная схема, владение символом внутри канала"
```

---

### Task 3: Конфиг с валидацией на старте

**Files:**
- Create: `apps/api/src/config/config.schema.ts`, `apps/api/src/config/config.module.ts`
- Test: `apps/api/test/config.test.ts`

**Interfaces:**
- Produces: `AppConfig` (тип), `loadConfig(env: NodeJS.ProcessEnv): AppConfig` — бросает на невалидном env.

- [ ] **Step 1: Написать падающий тест**

```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config/config.schema.js'

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'secret123',
  EXECUTION_MODE: 'dry_run',
  TG_APP_API_ID: '12345',
  TG_APP_API_HASH: 'abc',
  TG_SESSION: 'sess',
}

it('принимает валидный env', () => {
  expect(loadConfig(valid).executionMode).toBe('dry_run')
})

it('падает, если JWT_SECRET короче 32 символов', () => {
  expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/)
})

it('падает на неизвестном EXECUTION_MODE', () => {
  expect(() => loadConfig({ ...valid, EXECUTION_MODE: 'yolo' })).toThrow(/EXECUTION_MODE/)
})
```

- [ ] **Step 2: Запустить, убедиться что падает** (`Cannot find module`).

- [ ] **Step 3: Реализовать `config.schema.ts`**

```ts
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
```

- [ ] **Step 4: Тест зелёный.** Run: `pnpm --filter api test config`

- [ ] **Step 5: Commit** — `git commit -m "feat(api): конфиг с zod-валидацией на старте"`

---

### Task 4: Фильтр топика и сборка альбома (чистые функции)

Самая рискованная логика приёма. Тестируется на реальных данных из дампа, без сети.

**Files:**
- Create: `apps/tg-ingest/package.json`, `apps/tg-ingest/src/topic-filter.ts`, `apps/tg-ingest/src/album-buffer.ts`
- Test: `apps/tg-ingest/test/topic-filter.test.ts`, `apps/tg-ingest/test/album-buffer.test.ts`

**Interfaces:**
- Produces:
  - `topicOf(replyTo: ReplyHeaderLike | null | undefined, topicId: number): 'root' | 'reply' | 'other'`
  - `class AlbumBuffer { constructor(windowMs: number, flush: (msgs: Msg[]) => void); push(m: Msg): void; drain(): void }`

- [ ] **Step 1: Написать падающий тест фильтра топика**

Значения взяты из живых распечаток (`docs/superpowers/research/telegram-ingestion.md` §1).

```ts
import { describe, it, expect } from 'vitest'
import { topicOf } from '../src/topic-filter.js'

const TOPIC = 173666

it('221445 — настоящий ответ: replyToTopId заполнен', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: 221443, replyToTopId: TOPIC }, TOPIC)).toBe('reply')
})

it('221452 — обычный пост в топик: replyToTopId пуст', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: TOPIC, replyToTopId: null }, TOPIC)).toBe('root')
})

it('сообщение чужого топика отбрасывается', () => {
  expect(topicOf({ forumTopic: true, replyToMsgId: 999, replyToTopId: 111 }, TOPIC)).toBe('other')
})

it('сообщение не из форума отбрасывается', () => {
  expect(topicOf({ forumTopic: false, replyToMsgId: TOPIC, replyToTopId: null }, TOPIC)).toBe('other')
})

it('отсутствие replyTo отбрасывается', () => {
  expect(topicOf(null, TOPIC)).toBe('other')
})
```

- [ ] **Step 2: Запустить, убедиться что падает.** Run: `pnpm --filter tg-ingest test topic-filter`

- [ ] **Step 3: Реализовать `topic-filter.ts`**

```ts
export interface ReplyHeaderLike {
  forumTopic?: boolean
  replyToMsgId?: number | null
  replyToTopId?: number | null
}

/**
 * Различает корневой пост в топике и ответ на конкретное сообщение внутри него.
 *
 * Надёжный признак — replyToTopId: Telegram проставляет его тогда и только тогда,
 * когда отвечают на сообщение ВНУТРИ топика. У обычного поста в ветку он пуст,
 * а replyToMsgId равен id самого топика.
 */
export function topicOf(
  replyTo: ReplyHeaderLike | null | undefined,
  topicId: number,
): 'root' | 'reply' | 'other' {
  if (!replyTo?.forumTopic) return 'other'
  const actualTopic = replyTo.replyToTopId ?? replyTo.replyToMsgId
  if (actualTopic !== topicId) return 'other'
  return replyTo.replyToTopId == null ? 'root' : 'reply'
}
```

- [ ] **Step 4: Тест зелёный.**

- [ ] **Step 5: Написать падающий тест буфера альбома**

```ts
import { describe, it, expect, vi } from 'vitest'
import { AlbumBuffer } from '../src/album-buffer.js'

const msg = (id: number, groupedId: string | null, text = '') => ({ id, groupedId, text })

it('одиночное сообщение отдаётся сразу', () => {
  const flush = vi.fn()
  new AlbumBuffer(600, flush).push(msg(1, null))
  expect(flush).toHaveBeenCalledWith([msg(1, null)])
})

it('альбом собирается и отдаётся одним пакетом по таймауту', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(11, 'g1', 'подпись'))
  buf.push(msg(12, 'g1'))
  expect(flush).not.toHaveBeenCalled()
  vi.advanceTimersByTime(600)
  expect(flush).toHaveBeenCalledOnce()
  expect(flush.mock.calls[0][0].map((m: any) => m.id)).toEqual([11, 12])
  vi.useRealTimers()
})

it('каждое новое фото продлевает окно', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(21, 'g2'))
  vi.advanceTimersByTime(500)
  buf.push(msg(22, 'g2'))
  vi.advanceTimersByTime(500)
  expect(flush).not.toHaveBeenCalled()
  vi.advanceTimersByTime(100)
  expect(flush).toHaveBeenCalledOnce()
  vi.useRealTimers()
})

it('элементы альбома сортируются по id', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(32, 'g3')); buf.push(msg(31, 'g3'))
  vi.advanceTimersByTime(600)
  expect(flush.mock.calls[0][0].map((m: any) => m.id)).toEqual([31, 32])
  vi.useRealTimers()
})

it('drain отдаёт недособранные альбомы (graceful shutdown)', () => {
  vi.useFakeTimers()
  const flush = vi.fn()
  const buf = new AlbumBuffer(600, flush)
  buf.push(msg(41, 'g4'))
  buf.drain()
  expect(flush).toHaveBeenCalledOnce()
  vi.useRealTimers()
})
```

- [ ] **Step 6: Запустить, убедиться что падает.**

- [ ] **Step 7: Реализовать `album-buffer.ts`**

```ts
export interface AlbumMessage { id: number; groupedId: string | null }

/**
 * Telegram доставляет альбом N отдельными апдейтами. Копим их по groupedId,
 * пока не пройдёт окно тишины, и отдаём одним пакетом: подпись лежит ровно на
 * одном элементе (иногда её нет вовсе), и AI должна увидеть все фото сразу.
 */
export class AlbumBuffer<T extends AlbumMessage> {
  private readonly pending = new Map<string, { messages: T[]; timer: NodeJS.Timeout }>()

  constructor(
    private readonly windowMs: number,
    private readonly flush: (messages: T[]) => void,
  ) {}

  push(message: T): void {
    if (!message.groupedId) {
      this.flush([message])
      return
    }
    const key = message.groupedId
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing.timer)

    const messages = existing ? [...existing.messages, message] : [message]
    const timer = setTimeout(() => this.release(key), this.windowMs)
    this.pending.set(key, { messages, timer })
  }

  /** Отдаёт всё недособранное — вызывается при остановке процесса. */
  drain(): void {
    for (const key of [...this.pending.keys()]) this.release(key)
  }

  private release(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(key)
    this.flush([...entry.messages].sort((a, b) => a.id - b.id))
  }
}
```

- [ ] **Step 8: Тесты зелёные.** Run: `pnpm --filter tg-ingest test`

- [ ] **Step 9: Commit** — `git commit -m "feat(ingest): фильтр топика по replyToTopId и сборка альбомов"`

---

### Task 5: Приём сообщений — persist, дедуп, курсор

**Files:**
- Create: `apps/tg-ingest/src/repository.ts`, `apps/tg-ingest/src/media.ts`
- Test: `apps/tg-ingest/test/repository.test.ts` (интеграционный, против живого Postgres)

**Interfaces:**
- Consumes: `createDb`, `DB` из `apps/api/src/db/database.ts` (реэкспорт через `packages/shared` не нужен — импорт по workspace-пути `api/db`).
- Produces:
  - `saveMessage(db, input: IngestMessage): Promise<{ id: string; inserted: boolean }>`
  - `advanceCursor(db, channelId: number, tgMessageId: number): Promise<void>`
  - `getCursor(db, channelId: number): Promise<number>`
  - `pickMedia(media): DownloadHint | null` — выбирает фото или `PhotoSize`-thumbnail видео.

- [ ] **Step 1: Написать падающий тест**

```ts
it('повторная доставка того же сообщения не создаёт дубль', async () => {
  const input = { channelId: 1, tgMessageId: 555, text: 'x', msgTs: new Date(), raw: {} }
  const first = await saveMessage(db, input)
  const second = await saveMessage(db, input)
  expect(first.inserted).toBe(true)
  expect(second.inserted).toBe(false)
  expect(second.id).toBe(first.id)
})

it('курсор двигается только вперёд', async () => {
  await advanceCursor(db, 1, 100)
  await advanceCursor(db, 1, 50)   // бэкфилл принёс старое — курсор не откатывается
  expect(await getCursor(db, 1)).toBe(100)
})

it('правка помечает сообщение и увеличивает счётчик', async () => {
  const at = new Date()
  await saveMessage(db, { channelId: 1, tgMessageId: 556, text: 'v1', msgTs: at, raw: {} })
  await saveMessage(db, { channelId: 1, tgMessageId: 556, text: 'v2', msgTs: at, raw: {}, editedTs: at })
  const row = await db.selectFrom('messages').selectAll()
    .where('channel_id', '=', 1).where('tg_message_id', '=', 556).executeTakeFirstOrThrow()
  expect(row.text).toBe('v2')
  expect(row.edit_count).toBe(1)
})
```

- [ ] **Step 2: Запустить, убедиться что падает.**

- [ ] **Step 3: Реализовать `repository.ts`**

```ts
import { Kysely, sql } from 'kysely'
import type { DB } from '../../api/src/db/database.js'

export interface IngestMessage {
  channelId: number
  tgMessageId: number
  topicId: number | null
  groupedId: string | null
  replyToMsgId: number | null
  replyToTopId: number | null
  isTopicMessage: boolean
  text: string
  hasMedia: boolean
  mediaKind: string | null
  msgTs: Date
  editedTs: Date | null
  raw: unknown
}

export async function saveMessage(
  db: Kysely<DB>,
  input: IngestMessage,
): Promise<{ id: string; inserted: boolean }> {
  const isEdit = input.editedTs != null

  const row = await db
    .insertInto('messages')
    .values({
      channel_id: input.channelId,
      tg_message_id: input.tgMessageId,
      topic_id: input.topicId,
      grouped_id: input.groupedId,
      reply_to_msg_id: input.replyToMsgId,
      reply_to_top_id: input.replyToTopId,
      is_topic_message: input.isTopicMessage,
      text: input.text,
      has_media: input.hasMedia,
      media_kind: input.mediaKind,
      msg_ts: input.msgTs,
      edited_ts: input.editedTs,
      raw: JSON.stringify(input.raw),
    })
    .onConflict((oc) =>
      isEdit
        ? oc.columns(['channel_id', 'tg_message_id']).doUpdateSet((eb) => ({
            text: input.text,
            edited_ts: input.editedTs,
            edit_count: eb('messages.edit_count', '+', 1),
          }))
        // Повторная доставка — не ошибка: catchUp() в GramJS ничего не делает,
        // сообщение может продиспатчиться дважды, а бэкфилл на границе
        // перекрывается с live-потоком.
        : oc.columns(['channel_id', 'tg_message_id']).doNothing(),
    )
    .returning(['id'])
    .executeTakeFirst()

  if (row) return { id: row.id, inserted: !isEdit }

  const existing = await db
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', input.channelId)
    .where('tg_message_id', '=', input.tgMessageId)
    .executeTakeFirstOrThrow()

  return { id: existing.id, inserted: false }
}

export async function advanceCursor(db: Kysely<DB>, channelId: number, tgMessageId: number): Promise<void> {
  await db
    .updateTable('channels')
    .set({ last_seen_message_id: sql<number>`GREATEST(last_seen_message_id, ${tgMessageId})` })
    .where('id', '=', channelId)
    .execute()
}

export async function getCursor(db: Kysely<DB>, channelId: number): Promise<number> {
  const row = await db
    .selectFrom('channels')
    .select('last_seen_message_id')
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow()
  return Number(row.last_seen_message_id)
}
```

- [ ] **Step 4: Реализовать `media.ts`**

```ts
import { Api } from 'telegram'

/** Что передать в client.downloadMedia вторым аргументом. */
export type DownloadHint =
  | { kind: 'photo'; options: Record<string, never> }
  | { kind: 'video-thumb'; options: { thumb: Api.TypePhotoSize } }

/**
 * Видео в vision не отправить, поэтому берём статический thumbnail.
 * ВНИМАНИЕ: downloadMedia(msg, {thumb: -1}) качает ВЕСЬ mp4, а не превью —
 * нужен именно элемент thumbs с className === 'PhotoSize'.
 * Фото Telegram и так крошечные (~98 КБ / 1128 px), ресайз не нужен.
 */
export function pickMedia(media: Api.TypeMessageMedia | undefined): DownloadHint | null {
  if (media instanceof Api.MessageMediaPhoto) {
    return { kind: 'photo', options: {} }
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document
    if (!(doc instanceof Api.Document)) return null
    if (!doc.mimeType?.startsWith('video/')) return null // стикеры и прочее пропускаем
    const thumb = doc.thumbs?.find((t) => t.className === 'PhotoSize')
    return thumb ? { kind: 'video-thumb', options: { thumb } } : null
  }
  return null
}
```

Тест (`apps/tg-ingest/test/media.test.ts`): фото → `{kind:'photo'}`; документ `video/mp4` с
`thumbs: [PhotoStrippedSize, PhotoSize]` → `{kind:'video-thumb'}` и выбран именно `PhotoSize`;
стикер `application/x-tgsticker` → `null`.

- [ ] **Step 5: Тесты зелёные.** Run: `pnpm db:up && pnpm --filter tg-ingest test repository`

- [ ] **Step 6: Commit** — `git commit -m "feat(ingest): идемпотентный persist, курсор, выбор медиа"`

---

### Task 6: Воркер приёма — реалтайм и бэкфилл

**Files:**
- Create: `apps/tg-ingest/src/ingest.service.ts`, `apps/tg-ingest/src/main.ts`
- Test: `apps/tg-ingest/test/ingest.smoke.test.ts` (реальное подключение, read-only)

**Interfaces:**
- Consumes: `topicOf`, `AlbumBuffer`, `saveMessage`, `advanceCursor`, `getCursor`, `pickMedia`.
- Produces: `IngestService.start(): Promise<void>`, `IngestService.stop(): Promise<void>`.

Ключевые инварианты (из `docs/superpowers/research/telegram-ingestion.md`):

- `NewMessage({chats})` фильтрует только по `chatId` — топик отсеиваем сами через `topicOf`;
- `catchUp()` в GramJS — пустая заглушка, поэтому бэкфилл вызывается **на старте и после каждого реконнекта**;
- `setLogLevel(WARN)` глушит benign-`TIMEOUT` от keepalive-пинга, не ломая авто-реконнект;
- `FloodWaitError` имеет поле `.seconds`; до 60 с библиотека спит сама;
- перед `getEntity(id)` обязателен разовый `getDialogs({limit: 500})` — иначе нет `access_hash`.

- [ ] **Step 1: Написать smoke-тест (read-only, реальная сессия)**

```ts
it('видит оба источника и фильтрует топик', async () => {
  const service = new IngestService(config, db)
  await service.connect()
  const forum = await service.probeTopic(1962583820n, 173666, 5)
  expect(forum.length).toBeGreaterThan(0)
  expect(forum.every((m) => m.topicKind !== 'other')).toBe(true)
  await service.stop()
}, 60_000)
```

- [ ] **Step 2: Запустить, убедиться что падает.**

- [ ] **Step 3: Реализовать `ingest.service.ts`** — клиент, хэндлеры `NewMessage`/`EditedMessage`/`DeletedMessage`, буфер альбома, бэкфилл, обработчик `UpdateConnectionState`, `process.on('unhandledRejection')`, graceful shutdown с `buffer.drain()`.

```ts
const msgs = await this.client.getMessages(peer, {
  minId: lastSeen,      // строго новее обработанного
  reverse: true,        // от старых к новым: применяем по возрастанию id
  limit: 200,
  waitTime: 1,
  ...(topicId ? { replyTo: topicId } : {}),
})
```

- [ ] **Step 4: Прогнать smoke-тест.** Run: `pnpm --filter tg-ingest test ingest.smoke`
Expected: PASS, в логах видны реальные заголовки каналов.

- [ ] **Step 5: Проверить приём вживую**

Run: `pnpm --filter tg-ingest dev` и подождать нового сообщения, либо сбросить курсор:
`pnpm db:psql -c "UPDATE channels SET last_seen_message_id = last_seen_message_id - 5"`
Expected: в `messages` появились строки, `select count(*) from message_media` > 0.

- [ ] **Step 6: Commit** — `git commit -m "feat(ingest): воркер реалтайма и бэкфилла"`

---

### Task 7: Auth

**Files:**
- Create: `apps/api/src/auth/*`
- Test: `apps/api/test/auth.e2e.test.ts`

**Interfaces:**
- Produces: `POST /auth/login {username,password} → 204 + httpOnly cookie`, `POST /auth/logout → 204`, `GET /auth/me → {username}`; `JwtGuard`.

- [ ] **Step 1: Тесты** — успешный вход ставит куку; неверный пароль → 401; `/auth/me` без куки → 401; после `logout` кука пуста.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** — админ сидируется из `ADMIN_USERNAME`/`ADMIN_PASSWORD` при старте (`bcrypt`, upsert в `users`), JWT подписывается `jose` секретом `JWT_SECRET`, кука `httpOnly; sameSite=lax; secure` в проде.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): вход админа, JWT в httpOnly cookie"`

---

### Task 8: REST каналов и сообщений

**Files:**
- Create: `apps/api/src/channels/*`, `packages/shared/src/dto.ts`
- Test: `apps/api/test/channels.e2e.test.ts`

**Interfaces:**
- Produces (в `packages/shared`):

```ts
export interface ChannelDto {
  id: number; key: string; title: string; handle: string; initial: string
  status: 'active' | 'paused' | 'error'
  copyEnabled: boolean; winRate: string   // '—' пока нет закрытых сделок
  actionCount: number; activePositions: number; messageCount: number
  tradeSize: string; maxLeverage: string
}
export interface MessageDto {
  id: string; tgMessageId: number; time: string; text: string
  media: { url: string; kind: 'photo' | 'video-thumb' }[]
  aiSummary: string | null
  actions: MessageActionDto[]   // в Ф0 всегда []
  method: 'auto' | 'ai' | 'review' | null
}
```

- [ ] **Step 1: Тесты** — `GET /channels` возвращает оба засидженных канала; `GET /channels/:id/messages?limit=50` отдаёт по убыванию `tg_message_id`; без куки → 401.
- [ ] **Step 2: Убедиться, что падают.**
- [ ] **Step 3: Реализовать** сервис, контроллер и сид двух каналов (`ch-2088626562` → адаптер `ch1-structured`; `ch-1962583820-t173666`, `topic_id=173666` → `ch2-freeform`). Медиа отдаётся через `GET /media/:id` со стримом файла.
- [ ] **Step 4: Тесты зелёные.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): REST каналов и сообщений"`

---

### Task 9: WebSocket и outbox

**Files:**
- Create: `apps/api/src/realtime/*`, `packages/shared/src/ws-events.ts`
- Test: `apps/api/test/realtime.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ServerToClient {
  'message.new': (payload: { channelId: number; message: MessageDto }) => void
  'channel.stats': (payload: { channelId: number; messageCount: number; actionCount: number }) => void
}
```

`tg-ingest` после сохранения сообщения пишет строку в `domain_events` **в той же транзакции**, что и `messages`. `api` слушает `LISTEN domain_events`, читает неопубликованные строки, шлёт в комнату канала и проставляет `published_at`. Это переживает рестарт `api`: события не теряются.

- [ ] **Step 1: Тест** — клиент socket.io с валидной кукой получает `message.new` после `INSERT INTO domain_events`; без куки соединение отклоняется.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать** gateway с JWT-guard и `outbox.publisher.ts` на `pg` `LISTEN/NOTIFY`.
- [ ] **Step 4: Тест зелёный.**
- [ ] **Step 5: Commit** — `git commit -m "feat(api): WS-gateway и outbox domain_events"`

---

### Task 10: Фронт — каркас, токены, экран входа

**Files:**
- Create: `apps/web/*` (vite, tailwind, shadcn, роутер), `apps/web/src/routes/login.tsx`
- Test: `apps/web/test/login.test.tsx`

**Interfaces:**
- Produces: роуты `/login`, `/channels`, `/channels/:id`; `apiFetch`, `useAuth`.

- [ ] **Step 1: Тест** — форма показывает ошибку «Enter your login and password» при пустых полях; успешный вход редиректит на `/channels`.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Настроить Vite + Tailwind с токенами из таблицы выше**, подключить шрифт Exo 2 из `design/project/uploads/Exo_2/`, поставить shadcn (`button`, `input`, `table`, `tabs`, `switch`, `badge`, `card`, `sonner`).
- [ ] **Step 4: Сверстать экран входа 1:1** с `Admin.dc.html:43-68`: карточка `max-width:360px`, логотип `34px` квадрат `#ff6a1f` с чёрным квадратом `12px` внутри, заголовок `Sign in`, подпись `Access your copy-trading control panel`, поля `Login`/`Password`, кнопка `#ff6a1f` высотой `42px`.
- [ ] **Step 5: Тест зелёный.**
- [ ] **Step 6: Commit** — `git commit -m "feat(web): каркас, дизайн-токены, экран входа"`

---

### Task 11: Фронт — список каналов

**Files:**
- Create: `apps/web/src/routes/layout.tsx`, `apps/web/src/routes/channels.tsx`
- Test: `apps/web/test/channels.test.tsx`

- [ ] **Step 1: Тест** — таблица рендерит восемь колонок (`Channel`, `Copy`, `Win Rate`, `Actions`, `Active Positions`, `Messages`, `Trade size`, `Max lev`); клик по строке ведёт на `/channels/:id`; бейдж `Copy` зелёный при `copyEnabled`.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать layout** (сайдбар `246px` с пунктами Telegram Channels / Actions / Positions, топбар с крошками и Logout, bottom nav ниже `820px`) и таблицу по `Admin.dc.html:129-174`.
- [ ] **Step 4: Тест зелёный.**
- [ ] **Step 5: Commit** — `git commit -m "feat(web): layout и список каналов"`

---

### Task 12: Фронт — таймлайн сообщений с реалтаймом

**Files:**
- Create: `apps/web/src/routes/channel.tsx`, `apps/web/src/components/MessageTimeline.tsx`, `apps/web/src/lib/ws.ts`
- Test: `apps/web/test/timeline.test.tsx`

- [ ] **Step 1: Тест** — сообщение без действий рисует серую точку узла; сообщение с фото рисует картинку; событие `message.new` добавляет узел в начало без перезагрузки.
- [ ] **Step 2: Убедиться, что падает.**
- [ ] **Step 3: Реализовать таймлайн** по `Admin.dc.html:194-249`: вертикальная линия `left:15px`, плитка узла `32px` с радиусом `9px`, время моноширинным `11.5px` цветом `#5a5a60`, текст `14px` с `white-space: pre-line`, фото `max-width:340px`, высота `176px`, радиус `8px`. Блок действий и AI-саммари в Ф0 не рендерятся (появятся в Ф1–Ф2), но разметка предусмотрена.
- [ ] **Step 4: Подписка на `message.new`** через socket.io, вставка в кэш TanStack Query.
- [ ] **Step 5: Тест зелёный.**
- [ ] **Step 6: Commit** — `git commit -m "feat(web): таймлайн сообщений с реалтаймом"`

---

### Task 13: Сборка целиком и приёмка Ф0

**Files:**
- Modify: `docker-compose.yml` (сервисы `api`, `web`, `tg-ingest`), `package.json`
- Create: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/tg-ingest/Dockerfile`

- [ ] **Step 1: Добавить три сервиса в compose** с `depends_on: postgres (service_healthy)`, миграциями на старте `api`, и `tg-ingest` без публикации портов.
- [ ] **Step 2: Поднять всё.** Run: `pnpm up`
Expected: четыре контейнера `healthy` (`postgres`, `api`, `web`, `ai-proxy`) и `tg-ingest` в `running`.
- [ ] **Step 3: Приёмка вручную.** Открыть `http://localhost:5173`, войти под `ADMIN_USERNAME`/`ADMIN_PASSWORD`, увидеть два канала с корректными счётчиками сообщений, зайти в каждый и увидеть таймлайн с картинками.
- [ ] **Step 4: Проверить реалтайм.** Сбросить курсор одного канала на 3 сообщения назад:
`pnpm db:psql -c "UPDATE channels SET last_seen_message_id = last_seen_message_id - 3 WHERE key = 'ch-2088626562'"`
и перезапустить `tg-ingest`. Expected: три сообщения появляются в открытой вкладке **без перезагрузки страницы**, дублей в БД нет:
`pnpm db:psql -c "SELECT channel_id, tg_message_id, count(*) FROM messages GROUP BY 1,2 HAVING count(*) > 1"` → 0 строк.
- [ ] **Step 5: Обновить `LOOP_STATE.md`** — отметить Ф0 выполненной, записать замеченные грабли.
- [ ] **Step 6: Commit** — `git commit -m "feat: фаза 0 — живая лента обоих каналов"`

---

## Definition of Done для Ф0

- `pnpm up` поднимает postgres, api, web, tg-ingest и ai-proxy.
- Вход по логину и паролю из `.env`, JWT в httpOnly cookie.
- Оба источника видны в списке каналов с реальными счётчиками сообщений.
- Таймлайн показывает текст, фото и альбомы; новые сообщения прилетают по WebSocket.
- Повторная доставка и бэкфилл не создают дублей: запрос из Step 4 Task 13 возвращает ноль строк.
- Тесты: `pnpm test` зелёные во всех пакетах.

## Что осознанно не делается в Ф0

Парсеры, AI, сайзинг, ордера, страницы Actions и Positions, настройки канала. Вкладка Settings в детали канала рендерится, но поля задизейблены до Ф1. Колонки `Win Rate`, `Actions`, `Active Positions` показывают `—` и `0`, потому что источников данных для них ещё нет.
