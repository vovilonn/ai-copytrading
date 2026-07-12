# syntax=docker/dockerfile:1
# apps/api — NestJS. Multi-stage: deps (install из манифестов) → build (исходники + pnpm deploy
# --prod) → runtime (замыкание прод-зависимостей, non-root, tini). Приложение бежит через tsx
# (esbuild-транспиляция; exports пакетов → ./src/*, dist нет). tsx/dotenv в dependencies → deploy
# --prod оставляет их, отсекая vitest/typescript/supertest/test-db/@types. main.ts прогоняет
# миграции (migrateToLatest) ДО открытия порта.

# ── base: закреплённый Node + pnpm через corepack ───────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" CI=1
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# ── deps: установка ТОЛЬКО из манифестов — слой кешируется при правках исходников, инвалидируется
#    лишь при смене зависимостей. Store — в BuildKit-кеше между сборками. ──
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

# ── build: исходники + прод-прунинг только замыкания api + самодостаточный tsconfig (extends на
#    корневой tsconfig.base.json рвётся в pruned-deploy → esbuild/tsx падал бы на NestJS-декораторах). ──
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=api --prod deploy --legacy /prod \
    && cp tsconfig.base.json /prod/tsconfig.json

# ── runtime: минимальный образ (без pnpm/corepack/тулчейна), non-root, init для сигналов ──────
FROM node:22-alpine AS runtime
# TSX_TSCONFIG_PATH — применять tsconfig (с декораторами) глобально ко всем файлам, включая исходники
# workspace-пакетов в node_modules. NODE_ENV=production — дефолт (compose перекрывает на development
# для api: Secure-кука над http иначе не сохранится и вход сломается).
ENV NODE_ENV=production TSX_TSCONFIG_PATH=/app/tsconfig.json
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /prod /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
