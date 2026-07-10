# apps/api — NestJS. Монорепо целиком исполняется через tsx (esbuild-транспиляция на лету,
# без отдельного tsc-билда — см. apps/api/package.json: скрипт "dev" это "tsx watch src/main.ts",
# компилированного dist тут нет и заводить его не будем, чтобы не переписывать working-код
# (package.json#exports обоих пакетов api/shared указывает на ./src/*, а не на dist).
#
# Из-за этого "прод-зависимости" в привычном смысле (--prod, без devDependencies) не годятся:
# tsx и typescript — devDependencies, но нужны в рантайме контейнера, раз компилированного JS
# нет. Ставим зависимости всего workspace одним pnpm install (см. также README) — сознательный
# компромисс, отражённый в отчёте задачи 13.
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
# python3/make/g++/git — на случай, если у кого-то из транзитивных зависимостей (напр. optional
# nativeaddon'ы у ws/telegram) есть install-скрипт, который иначе упадёт на musl-alpine без тулчейна.
RUN apk add --no-cache python3 make g++ git
# Копируем монорепо целиком (не только apps/api): apps/tg-ingest зависит от 'api' как от
# workspace-пакета и импортирует его исходники напрямую (apps/tg-ingest/src/main.ts), а
# `pnpm install --frozen-lockfile` в pnpm-workspace вообще требует консистентности ВСЕХ
# участников lockfile, иначе падает на рассинхроне. .dockerignore уже вырезал node_modules,
# var, .git, .env и служебные каталоги — копировать всё безопасно.
COPY . .
RUN pnpm install --frozen-lockfile

# Финальный слой без pnpm store/apk-кэша сборочной стадии — их не тащим (deps лежат в
# node_modules самого /app, через симлинки на pnpm virtual store внутри него же).
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY --from=deps /app /app

WORKDIR /app/apps/api
EXPOSE 3000

# main.ts сам прогоняет миграции (migrateToLatest) ДО открытия порта и только потом
# поднимает HTTP-сервер (см. apps/api/src/main.ts) — отдельного шага "сначала migrate,
# потом server" в CMD не нужно, он уже зашит в код.
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
