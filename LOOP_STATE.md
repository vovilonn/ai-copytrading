# LOOP_STATE

## Goal (Docker-оптимизация) — ✅ ЗАВЕРШЕНО

Оптимизировать Docker: buildx-кеш для pnpm, раздельные build/runtime образы (multi-stage),
production-ready по бест-практикам.

## Что сделано
- **Multi-stage build/runtime разделение** (api/engine/tg-ingest): stage `build` (полный install +
  тулчейн) → `pnpm deploy --prod` → stage `runtime` только с замыканием прод-зависимостей. web:
  builder(Node)→runtime(nginx), как было.
- **BuildKit cache-mount для pnpm store** (`--mount=type=cache,id=pnpm-store,target=/pnpm/store`) —
  общий на все образы, пересборки почти не качают пакеты.
- **Layer caching через `pnpm fetch`**: stage `fetch` копирует ТОЛЬКО lockfile → store; install-слой
  инвалидируется лишь при смене lockfile, не исходников.
- **Прунинг dev-зависимостей**: tsx+dotenv перенесены в `dependencies` (реально нужны в рантайме, tsx
  использует esbuild, не пакет typescript); `pnpm deploy --prod` отсекает vitest/typescript/test-db/
  fast-check/playwright/@testing-library/jsdom/supertest/big-integer/socket.io-client.
- **Бест-практики рантайма**: non-root (`USER node`), `tini` как PID1 (сигналы/зомби), `NODE_ENV=production`
  (compose перекрывает на development для api — Secure-кука над http), HEALTHCHECK (api /api/health,
  web /healthz), tsx запускается напрямую (`node_modules/.bin/tsx`, без pnpm/corepack в рантайме).
- **tsconfig-фикс**: pruned-deploy рвёт `extends "../../tsconfig.base.json"` → esbuild/tsx падал на
  NestJS-декораторах. Кладём самодостаточный `tsconfig.base.json` как `/app/tsconfig.json` +
  `TSX_TSCONFIG_PATH` (применяет декораторы глобально).
- **.dockerignore** расширен (docs/design/кеши/Dockerfile-мета/coverage/tsbuildinfo).

## Результат
- Размеры: api 300MB, engine 302MB, tg-ingest 314MB (было ~606MB → **−50%**), web 77.5MB.
- Весь стек поднят на новых образах и здоров: api healthy, web healthy, engine live (reconcile 0/0/0,
  реальный equity, private-ws OK, снапшоты пишутся), tg-ingest подключён к Telegram (по существующей
  сессии, без ре-логина).
- UI работает (web SPA 200, прокси /api/health 200). typecheck 5/5. Тесты: shared 25, api 116+1skip,
  tg-ingest 40, engine 403+18skip, web 80 = 664 зелёных.

## Status
- [x] Всё реализовано, собрано, поднято, проверено. Осталось: коммит.
