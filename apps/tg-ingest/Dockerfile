# syntax=docker/dockerfile:1
# apps/tg-ingest — воркер MTProto (ровно одна реплика, см. docker-compose.yml). Та же схема, что
# apps/engine/Dockerfile: multi-stage build (полный install + pnpm deploy --prod) → runtime
# (замыкание прод-депов, non-root, tini). Портов не публикует. tsx/dotenv в dependencies →
# deploy --prod оставляет их, отсекая vitest/typescript/test-db/big-integer.

# ── base: закреплённый Node + pnpm через corepack ───────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# ── fetch: только lockfile → pnpm store в BuildKit-кеше ──────────────────────
FROM base AS fetch
COPY pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ── build: полный офлайн-install из store + прод-прунинг только замыкания tg-ingest ───────────
FROM fetch AS build
RUN apk add --no-cache python3 make g++
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# deploy + самодостаточный tsconfig (apps/*/tsconfig наследует decorators/metadata из корневого
# tsconfig.base.json через extends, которого в pruned-deploy нет — иначе tsx падает на декораторах
# в импортируемых исходниках api).
RUN pnpm --filter=tg-ingest --prod deploy --legacy /prod \
    && cp tsconfig.base.json /prod/tsconfig.json

# ── runtime: минимальный образ (без pnpm/corepack/тулчейна), non-root, init для сигналов ──────
FROM node:22-alpine AS runtime
# TSX_TSCONFIG_PATH заставляет tsx применять tsconfig (с декораторами) глобально ко всем файлам.
ENV NODE_ENV=production TSX_TSCONFIG_PATH=/app/tsconfig.json
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /prod /app
USER node
# main.ts прогоняет миграции (idempotent) перед стартом. tsx напрямую; tini — PID1.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
