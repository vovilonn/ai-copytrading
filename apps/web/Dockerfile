# syntax=docker/dockerfile:1
# apps/web — статика Vite за nginx. Multi-stage: deps (install из манифестов) → build (исходники +
# vite build) → runtime (nginx со статикой, без node-рантайма). nginx выбран вместо `vite preview`
# (Vite документирует preview как локальный инструмент) и даёт reverse-proxy с websocket-апгрейдом
# для /socket.io. Прод-прунинг не нужен: в образ идёт только dist/, node_modules остаётся в сборке.

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

# ── build: исходники + сборка Vite (tsc --noEmit && vite build) ──────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter=web build

# ── runtime: nginx со статикой, без node ─────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
