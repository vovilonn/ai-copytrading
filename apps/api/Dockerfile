# syntax=docker/dockerfile:1
# apps/api — NestJS. Multi-stage: build (полный install + прод-прунинг через pnpm deploy) →
# runtime (только замыкание прод-зависимостей, non-root, tini). Приложение бежит через tsx
# (esbuild-транспиляция на лету; exports пакетов указывают на ./src/*, компилированного dist нет).
# tsx/dotenv вынесены в dependencies — pnpm deploy --prod оставляет их, а vitest/typescript/
# supertest/test-db/@types отсекает. main.ts прогоняет миграции (migrateToLatest) ДО открытия порта.

# ── base: закреплённый Node + pnpm через corepack ───────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# ── fetch: только lockfile → pnpm store в BuildKit-кеше. Слой инвалидируется лишь при смене
#    lockfile (не исходников) → пересборки почти не качают пакеты. ──
FROM base AS fetch
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ── build: полный офлайн-install из store + прод-прунинг только замыкания api ─────────────────
FROM fetch AS build
RUN apk add --no-cache python3 make g++
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# deploy собирает /prod, затем кладём САМОДОСТАТОЧНЫЙ tsconfig: в монорепо apps/*/tsconfig.json
# наследует experimentalDecorators/emitDecoratorMetadata из корневого tsconfig.base.json через
# extends "../../tsconfig.base.json", но в pruned-deploy корневого файла нет → цепочка рвётся, и
# esbuild/tsx падает на NestJS-декораторах. Базовый tsconfig самодостаточен (без extends).
RUN pnpm --filter=api --prod deploy --legacy /prod \
    && cp tsconfig.base.json /prod/tsconfig.json

# ── runtime: минимальный образ (без pnpm/corepack/тулчейна), non-root, init для сигналов ──────
FROM node:22-alpine AS runtime
# TSX_TSCONFIG_PATH заставляет tsx применять этот tsconfig (с декораторами) ГЛОБАЛЬНО ко всем
# транспилируемым файлам, включая исходники workspace-пакетов в node_modules.
ENV NODE_ENV=production TSX_TSCONFIG_PATH=/app/tsconfig.json
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /prod /app
USER node
EXPOSE 3000
# tsx запускается напрямую (не `pnpm exec` — тот под non-root дёргал бы corepack). tini — PID1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
