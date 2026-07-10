# apps/web — статика Vite за nginx (выбор вместо `vite preview`: сам Vite документирует preview
# как инструмент ДЛЯ ЛОКАЛЬНОЙ проверки прод-сборки, а не как прод-сервер; nginx отдаёт статику
# без node-рантайма в финальном образе и даёт полноценный reverse-proxy с апгрейдом до
# websocket для /socket.io, который нужен по брифу задачи 13).
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
# Монорепо целиком: apps/web зависит от workspace-пакета 'shared' (packages/shared/src/*),
# а `pnpm install --frozen-lockfile` требует консистентности всех участников lockfile.
COPY . .
RUN pnpm install --frozen-lockfile
# "build" = "tsc --noEmit && vite build" (apps/web/package.json) — типchecking + сборка в dist/.
RUN pnpm --filter web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
