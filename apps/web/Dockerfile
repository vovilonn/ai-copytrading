# syntax=docker/dockerfile:1
# apps/web — статика Vite за nginx. Multi-stage: build (Node + полный install + vite build) →
# runtime (nginx со статикой, без node-рантайма). nginx выбран вместо `vite preview` (Vite
# документирует preview как локальный инструмент, а не прод-сервер) и даёт reverse-proxy с
# websocket-апгрейдом для /socket.io. Прод-прунинг тут не нужен: в финальный образ идёт только
# собранный dist/, node_modules сборки остаётся в build-стадии.

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

# ── build: офлайн-install из store + сборка Vite (tsc --noEmit && vite build) ─────────────────
FROM fetch AS build
RUN apk add --no-cache python3 make g++
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
RUN pnpm --filter=web build

# ── runtime: nginx со статикой, без node ─────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
