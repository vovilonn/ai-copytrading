# LOOP_STATE

## Goal

Production-ready AI копитрейдинг-платформа:

- **Ingestion:** Telegram MTProto userbot, каналы `2088626562` и форум `1962583820` (топик «A TRADING», `173666`).
- **Понимание:** детерминированный парсер + AI-слой (текст **и картинки**) через локальный `ai-proxy`. Цель AI — 100% покрытие, ни один action не потерян.
- **Исполнение:** Bybit V5 (`linear`). Фиксированный notional из настроек канала, дефолтное и максимальное плечо, пересчёт плеча если SL за ценой ликвидации.
- **UI:** React (Vite) + shadcn, 1:1 по `design/project/Admin.dc.html`. Страница позиций стримится в реальном времени.
- **Проверка:** реальные API; Bybit — testnet.

Процесс: superpowers (brainstorming → writing-plans → реализация по фазам).

## Установленные факты

Проверено вживую, не по документации:

- **ai-proxy** (`http://127.0.0.1:8317`) авторизован под `dcsport111@gmail.com` (Claude-подписка).
  - `/v1/messages` отвечает; доступны `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-*` и др.
  - **Structured output работает**: `tool_choice: {type:"tool"}` → `stop_reason: tool_use` с валидным JSON.
  - **Vision работает**: base64 PNG в `content[].image` распознаётся.
  - Прокси подмешивает системный промпт Claude Code (~1.3k input-токенов на запрос) — учитывать в стоимости.
- **Bybit**: ключи в `.env` теперь **testnet** (`api-testnet.bybit.com`, `retCode=0`). Mainnet-ключи закомментированы.
  - Баланс testnet пуст → перед e2e нужен faucet.
  - Прошлые mainnet-ключи имели права `ContractTrade: Order, Position` (не read-only).
- **Telegram**: сессии нет. `TG_APP_API_ID`/`TG_APP_API_HASH` есть, `TG_SESSION` создаётся входом по телефону.

## Дизайн: что должен уметь фронт

Разобран `design/project/Admin.dc.html` целиком.

- **Auth**: экран логина (login/password), logout.
- **Навигация**: сайдбар (Telegram Channels / Actions / Positions) + Settings; на мобиле — bottom nav; хлебные крошки.
- **Channels**: таблица — Channel (аватар-инициал, name, handle), Copy (On/Off), Win Rate, Actions, Active Positions, Messages, Trade size, Max lev.
- **Channel → Messages**: таймлайн сообщений (время, текст, фото), под каждым — блок распознанных actions (1..N строк: иконка, заголовок + процент, пара, ссылка «Trade #TR-xxxx» → на Positions с фильтром, либо бейдж «Skipped» если копитрейд выключен) + AI-саммари (sparkles) когда `method === 'ai'`.
- **Channel → Settings**: Copy trading (toggle), Trade size ($), Max leverage (x), Default leverage (x, опционально), Allow cross margin (toggle), Save + флеш «Saved».
- **Actions**: фильтры Channel / Period (All, Today, 7d, 30d) / Type (Open, Close, Partial TP, Partial close) / Side + поиск по паре. Таблица: Action, Pair, Summary, Trade, Channel, Time, Method (AI parsing / Auto parsing). Пустое состояние.
- **Positions**: 4 стат-карточки (Open positions, Unrealised PnL, Position value, Margin used), фильтры Channel / Side / Margin + поиск по symbol/channel/#TR-ID. Таблица: Symbol, Side, Size, Entry, Mark, Liq. price, Unreal. PnL + ROI, TP/SL, Leverage + чип Cross/Isolated, Source (канал + #TR-ref).
- **Токены**: фон `#000`, карточка `#0d0d0f`, границы `rgba(255,255,255,.07)`, акцент `#ff6a1f`, long `#34d399`, short `#fb7185`, skipped `#fbbf24`. Шрифт `Exo 2`, моно — `ui-monospace`. Иконки только lucide.
- **Типы actions в UI**: `open` (long/short), `close`, `partial_tp`, `partial_close`. Сущность **Trade (#TR-xxxx)** связывает actions и позицию.

## Анализ реальных сообщений (по 100 из каждого источника)

Дамп: `temp/tg-dump/<channel>/messages.jsonl` + `media/*.jpg`.

| | канал 2088626562 | форум, топик A TRADING |
|---|---|---|
| Структурные входы | 27 (жёсткий шаблон) | 7 |
| Дельты | 30, **reply на сам сигнал** | 25, в основном reply на корень топика |
| Шум | 29 «обзоров» + 11 прочего | 33 коммента |
| Сообщений < 25 символов | 1 | 42 |
| С фото | 80 | 47 |

Выводы:

- **Канал 2088626562** — регулярный: `#TICKER/USDT 📈LONG`, `Диапазон входа: a - b$`, `TP: x$ - y$ - z$`, `SL: s$`, `Риск: N%`. Дельты приходят `reply` на сообщение-сигнал → **позиция матчится детерминированно**, без state-догадок. Опасный шум: `#BTC обзор 💸` содержит цены BTC, но сигналом не является.
- **Форум A TRADING** — свободный чат. `2🎯`, `Фикс половину`, `Стоп на твх`, `Sl 74`. **Текст без картинки бессмыслен**: у `2🎯` приложена карточка WEEX с `SOLUSDT, Лонг, 10x, вход 79,28, закрытие 82,29`. Vision обязателен. Цели склеены emoji-цифрами: `1️⃣80.82️⃣82.33️⃣84`. Встречаются несколько ордеров в одном сообщении: `Limit long btc 60850 + limit long btc 60000`.

## Решения по ТЗ (утверждены заказчиком)

1. **Изоляция каналов:** один символ — один канал. Первый занявший `BTCUSDT` владеет им до закрытия; сигнал другого канала → `Skipped` с причиной. (Bybit в one-way режиме держит одну позицию на символ.)
2. **Тейки:** лесенка частичных TP на бирже (`tpslMode: Partial`), равными долями по числу целей из сообщения. Стопы/тейки живут на бирже — сработают, даже если бот лежит.
3. **Dry-run:** глобальный `EXECUTION_MODE=dry_run|live` в `.env` поверх per-channel тоггла Copy trading.
4. **Сайзинг** (fixed-fractional с фолбэком):
   ```
   есть Риск% и SL  →  notional = (Риск% × equity) / stopDistance,  stopDistance = |entry − SL| / entry
   нет Риск%        →  notional = Trade size канала            (фолбэк, работает для обоих каналов)
   нет SL           →  Skipped: без стопа не посчитать ни размер, ни безопасное плечо
   ```
   Нужен жёсткий потолок notional — узкий стоп (0.5%) иначе даёт notional в разы больше депозита.
5. **Плечо:** берём default канала; если цена ликвидации ближе SL — понижаем, пока liq не уйдёт за SL (с буфером); всегда `≤ Max leverage` канала и `≤ maxLeverage` инструмента.
6. **Доливки** исполняются и показываются в UI как ещё один `Open` в той же сделке `#TR-x`.
7. **Вход диапазоном:** цена внутри → market; ещё не дошла → limit на ближнюю границу; ушла за диапазон → Skipped. Неисполненные лимитки отменяются по TTL (иначе сработают через неделю, когда сигнал уже неактуален).

## Пересмотр решений после верификации

Рецензент опроверг три решения доказательствами из дампа. Пересогласовано с заказчиком:

1. **Изоляция → субаккаунт Bybit на канал** (было: один символ — один канал). Причина: 30 июня
   оба канала держали SOL long одновременно (форум с 12:39, канал с 14:34, закрыт в плюс) —
   на одном one-way аккаунте сделка была бы потеряна. Ключ в `.env` оказался мастер-ключом
   (`isMaster: true`, права `AccountTransfer`+`SubMemberTransfer`) — провижининг возможен.
   Побочно чинит тумблер cross/isolated (в UTA режим маржи аккаунт-уровневый) и фильтр Margin.
2. **Вход без SL → входим со страховочным SL** (было: Skipped). Причина: форум почти всегда
   постит вход без стопа, стоп приходит отдельным поздним сообщением (`221353` → `221355`).
   Правило Skipped оставило бы каналу 7 сигналов из 100.
3. **TP:** цели из сообщения, если нет — свои. Последующие сообщения, меняющие ещё не
   сработавшие TP/SL, двигают выставленные ордера (`amend`). «Зафиксировал 50%» — событие,
   не команда (иначе двойное закрытие).
4. **«Один объём» = одна лега** (вход или добор). Позиция — список лег.

## Ключевые находки верификации

- **ai-proxy молча игнорирует поле `system`** — инструкции класть в user-turn с `cache_control`.
  Prompt caching работает. Прокси добавляет ~1370 input-токенов в каждый запрос. Это SPOF (был 502).
- **Двухступенчатость haiku→sonnet отвергнута эмпирикой:** haiku теряет 2–4.5% действий и выходит
  дороже ($12.03 против $11.65 за 1000). Одна ступень Sonnet 4.5 (F1 0.891), эскалация на Opus 4.8.
- **Признак ответа в топике — `replyToTopId`, а не `replyToMsgId`** (проверено на 221445/221452).
  Без колонки `reply_to_top_id` в реалтайме терялось бы 14% дельт форума.
- **`orderLinkId` нельзя строить от `tradeId`** — краш между отправкой ордера и персистом даёт
  дубль. Ключ — координаты сообщения: `K02-221452-00-E0`. Префикс `D` для dry-run.
- **`catchUp()` в GramJS — пустая заглушка**, `getDifference` нет: пропуск после обрыва библиотека
  не восстанавливает, а сообщение может прийти дважды. Бэкфилл — наш, дедуп обязателен.
- «Error: TIMEOUT» из `updates.js` — штатный keepalive-пинг, за ним идёт авто-реконнект.
- **24 из 25 сообщений топика имеют `editDate`** — правки норма. Политика «любая правка →
  needs_review» парализовала бы систему; нужен дифф против исполненной версии.
- `downloadMedia(msg, {thumb: -1})` качает весь mp4, а не превью — брать `PhotoSize` из `thumbs`.
- `GRASSUSDT`/`EIGENUSDT` на testnet `status=Closed` → гейт `status == 'Trading'`.
- `maxLeverage` расходится testnet/mainnet — клампить по инструменту сети исполнения.
- Автор форума держал лимитку на BTC 61000 **трое суток** → TTL 24ч сломал бы план; TTL = 7 дней
  как защитный потолок, отмена — по явным сообщениям.

## Status

- [x] Изучен `design/`, `temp/tg-signal-bot-architecture.md`, окружение
- [x] Проверены ai-proxy (tool_use + vision) и Bybit testnet (REST + private/public WS)
- [x] `scripts/tg-login.mjs`, `scripts/tg-dump.mjs`, `scripts/lib/tg.mjs` + pnpm-скрипты
- [x] `pnpm tg:login` выполнен, `TG_SESSION` в `.env`
- [x] Выгружены и проанализированы 200 реальных сообщений
- [x] Верификация допущений: 6 исследований + злой рецензент + проверяющий
      (`docs/superpowers/research/`)
- [x] Пересогласованы решения, опровергнутые верификацией
- [x] Дизайн-док: `docs/superpowers/specs/2026-07-10-ai-copytrading-platform-design.md`
- [x] **Аппрув спеки заказчиком**
- [x] План реализации по фазам (writing-plans)
- [x] **Ф0 реализована и принята** (задача 13: docker-compose целиком, приёмка вручную —
      см. `.superpowers/sdd/task-13-report.md`): вход, оба канала с реальными счётчиками,
      таймлайны с текстом/фото/альбомами, реалтайм по WebSocket без перезагрузки страницы,
      дедуп подтверждён (0 дублей `channel_id, tg_message_id`), `pnpm test`/`pnpm typecheck` зелёные.
- [ ] Ф1–Ф4: парсер, AI-слой, исполнение на Bybit, страницы Actions/Positions

## Известные грабли

- Порт `8317` у ai-proxy нельзя переназначать: OAuth-редирект жёстко ведёт на `127.0.0.1:<port из конфига>`.
- Внутри `ai-proxy/` лежит свой `docker-compose.yml`; compose ищет файл вверх по дереву — команды запускать из корня.
- `--force` у pnpm-скрипта перехватывается самим pnpm, поэтому флаг называется `--relogin`.
- Баланс Bybit testnet пуст — перед e2e нужен faucet на `testnet.bybit.com`.

## Грабли Ф0 (задача 13 — docker-compose и приёмка)

- `pg` отдаёт `BIGINT` строкой → зарегистрирован `setTypeParser(INT8, Number)`.
- `msg.chatId` в GramJS — marked id (`-100<id>`), сырой id лежит в `msg.peerId`.
- `saveMessage.inserted` нельзя выводить из `editedTs`: сообщения форума приходят уже с
  `editDate`. Признак реальной вставки — `RETURNING (xmax = 0)`.
- `catchUp()` в GramJS — заглушка, бэкфилл только свой.
- Скачивание медиа падало при массовом бэкфилле и глушилось → нужны ретраи и ремонтный проход
  (`apps/tg-ingest/src/retry.ts`, `media-repair.ts`).
- Альбом Telegram — это N сообщений с общим `grouped_id`; группировать в один узел таймлайна
  должен API (`apps/api/src/channels/channels.service.ts`), не ingest.
- Vite-прокси по префиксу `/channels` перехватывал SPA-роут → весь HTTP API вынесен под `/api`
  (`app.setGlobalPrefix('api')`), это же зеркалит `apps/web/nginx.conf` в контейнере.
- Порт `5432` на хосте занят другим проектом → `POSTGRES_PORT=5442` (проброшен только наружу;
  внутри сети compose `api`/`tg-ingest` ходят в `postgres:5432` напрямую).
- vitest/esbuild не эмитит `design:paramtypes` → в NestJS-провайдерах обязателен явный
  `@Inject(Class)` (актуально и для нового `HealthController` — не понадобился, DI без параметров).
- **`pnpm up` — не наш скрипт**: pnpm резервирует `up` как alias для `pnpm update`, поэтому
  голый `pnpm up` тихо не запускает `docker compose up`, а гоняет resolution зависимостей.
  Нужно `pnpm run up` (или `pnpm run down`/`pnpm run logs` для симметрии).
- **`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` в чистом контейнере**: `pnpm-lock.yaml` записан с
  `settings.injectWorkspacePackages: true`, а этот флаг на хосте стоял только в глобальном
  `~/Library/Preferences/pnpm/rc`, не в репозитории — в Docker (нет глобального rc) `pnpm install
  --frozen-lockfile` падал. Зафиксировано явно в корневом `.npmrc` (`inject-workspace-packages=true`),
  чтобы сборка не зависела от конфигурации конкретной машины.
- **Секьюр-кука ломает вход за `http`**: `sessionCookieOptions()` ставит `Secure` только при
  `NODE_ENV=production`. Весь стек здесь работает по обычному http (`127.0.0.1:5173`, без TLS) —
  если по привычке выставить `NODE_ENV=production` в compose для `api`, браузер тихо не сохранит
  куку и вход будет молча не работать (без единой ошибки в сети). В `docker-compose.yml` `api`
  намеренно держит `NODE_ENV=development`.
- **`apps/api`/`apps/tg-ingest` рантайм — это `tsx`, не скомпилированный JS**: `exports` в
  `package.json` обоих пакетов указывают на `./src/*`, а `tg-ingest` импортирует исходники `api`
  напрямую как workspace-зависимость. Значит "прод-зависимости" в Dockerfile в привычном смысле
  (`--prod`, без devDependencies) не подходят — `tsx`/`typescript` нужны в рантайме контейнера.
  Ставим зависимости всего workspace одним `pnpm install` (без `--prod`) — осознанный компромисс,
  задокументирован в `.superpowers/sdd/task-13-report.md`.
- `RealtimeGateway` (WS) жёстко проверяет `Origin: http://localhost:5173` на хендшейке — порт
  веб-контейнера в compose нельзя менять без правки кода, поэтому `127.0.0.1:5173:80` — не
  только рекомендация брифа, но и жёсткое требование текущего кода.
- Media-контроллер `api` читает файлы с диска (`var/media/...` относительно корня репозитория) —
  контейнеру `api` тоже нужен том `./var:/app/var`, не только `tg-ingest` (иначе картинки в
  таймлайне не отдаются, 404).
