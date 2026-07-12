# syntax=docker/dockerfile:1
# apps/tg-ingest — воркер MTProto (ровно одна реплика). Multi-stage: deps (install из манифестов) →
# build (исходники + pnpm deploy --prod) → runtime (замыкание прод-зависимостей, non-root, tini).
# Портов не публикует. tsx/dotenv в dependencies → deploy --prod оставляет их, отсекая
# vitest/typescript/test-db/big-integer.

# ── base: закреплённый Node + pnpm через corepack ───────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# ── deps: установка ТОЛЬКО из манифестов — слой кешируется при правках исходников. Store в кеше. ──
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY apps/engine/package.json ./apps/engine/
COPY apps/tg-ingest/package.json ./apps/tg-ingest/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/test-db/package.json ./packages/test-db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build: исходники + прод-прунинг только замыкания tg-ingest + самодостаточный tsconfig (extends
#    на корневой рвётся в pruned-deploy → tsx падал бы на декораторах в импортируемых исходниках api). ──
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=tg-ingest --prod deploy --legacy /prod \
    && cp tsconfig.base.json /prod/tsconfig.json

# ── runtime: минимальный образ (без pnpm/corepack/тулчейна), non-root, init для сигналов ──────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production TSX_TSCONFIG_PATH=/app/tsconfig.json
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /prod /app
USER node
# main.ts прогоняет миграции (idempotent) перед стартом. tsx напрямую; tini — PID1.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
