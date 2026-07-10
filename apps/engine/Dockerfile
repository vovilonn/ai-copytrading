# apps/engine — единственный писатель к бирже (в Ф1 — в БД через DryRunAdapter), ровно одна
# реплика (см. docker-compose.yml). Та же схема сборки, что и apps/tg-ingest/Dockerfile
# (обоснование — там же): монорепо целиком, tsx в рантайме, без публикации портов — воркер
# ничего не слушает по сети (кроме исходящих подключений к Postgres).
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
RUN apk add --no-cache python3 make g++ git
# engine импортирует исходники apps/api ('api/db/database.js', 'api/config/config.schema.js' и
# т.п., workspace-зависимость) — весь монорепо нужен целиком, не только apps/engine.
COPY . .
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY --from=deps /app /app

WORKDIR /app/apps/engine

# main.ts сам прогоняет миграции перед стартом (idempotent — на случай, если api ещё не успел
# прогнать свои). Без --watch: dev-скрипт tsx watch не нужен в контейнере, файлы не меняются.
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
