# syntax=docker/dockerfile:1
# apps/engine — воркер исполнения. Multi-stage: build (полный install + прод-прунинг через
# pnpm deploy) → runtime (только замыкание прод-зависимостей, non-root, tini). Приложение бежит
# через tsx (esbuild-транспиляция на лету; exports пакетов указывают на ./src/*, компилированного
# dist нет). tsx/dotenv вынесены в dependencies — поэтому pnpm deploy --prod оставляет их, а
# vitest/typescript/test-db/fast-check отсекает.

# ── base: закреплённый Node + pnpm через corepack ───────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# ── fetch: только lockfile → наполнение pnpm store в BuildKit-кеше. Слой инвалидируется
#    ТОЛЬКО при изменении lockfile (не исходников) → пересборки почти не качают пакеты. ──
FROM base AS fetch
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ── build: полный офлайн-install из store + прод-прунинг только замыкания engine ─────────────
FROM fetch AS build
# Тулчейн только для сборочной стадии — на случай install-скриптов нативных аддонов (esbuild).
RUN apk add --no-cache python3 make g++
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# pnpm deploy собирает самодостаточный каталог /prod: engine + его прод-депы (api, shared, decimal.js,
# kysely, pg, tsx, dotenv), с исходниками workspace-пакетов; dev-зависимости отсечены. Затем кладём
# самодостаточный tsconfig (в монорепо apps/*/tsconfig наследует decorators/metadata из корневого
# tsconfig.base.json через extends, которого в pruned-deploy нет — иначе esbuild/tsx падает на
# декораторах в импортируемых исходниках api).
RUN pnpm --filter=engine --prod deploy --legacy /prod \
    && cp tsconfig.base.json /prod/tsconfig.json

# ── runtime: минимальный образ (без pnpm/corepack/тулчейна), non-root, init для сигналов ──────
FROM node:22-alpine AS runtime
# TSX_TSCONFIG_PATH заставляет tsx применять tsconfig (с декораторами) глобально ко всем файлам,
# включая исходники workspace-пакетов в node_modules.
ENV NODE_ENV=production TSX_TSCONFIG_PATH=/app/tsconfig.json
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /prod /app
USER node
# tsx запускается НАПРЯМУЮ через свой бинарь (не `pnpm exec` — тот под non-root дёргал бы corepack).
# main.ts сам прогоняет миграции (idempotent) перед стартом воркера. tini — PID1, форвардит сигналы.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
