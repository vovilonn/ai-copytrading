# Деплой в прод: поэтапно

Гайд рассчитан на чистый Linux-сервер и разворачивание «с нуля до реальных сделок». Порядок этапов
не произвольный: каждый следующий включается только после того, как предыдущий доказал, что
работает. Бот, который торгует реальными деньгами, обязан сначала показать, что он правильно
**читает** и правильно **молчит**.

Что где живёт:

| Сервис | Роль | Порт (только loopback) |
|---|---|---|
| `postgres` | состояние: сообщения, действия, сделки, ордера, позиции | `5442` |
| `api` | REST + WebSocket для админки, миграции при старте | внутренний `3000` |
| `web` | статика админки + nginx-прокси на `api` | `5173` |
| `tg-ingest` | читает каналы Telegram, пишет сообщения в БД | — |
| `engine` | разбор, риск, ордера на Bybit, зеркало позиций | — |
| `ai-proxy` | доступ к модели по вашей подписке Claude | `8317`, `54545` |

Все порты публикуются **только на 127.0.0.1** — снаружи ничего не торчит. Доступ к админке — через
SSH-туннель (по умолчанию) либо через ваш reverse-proxy с TLS (см. §10, там есть два обязательных
условия).

---

## 1. Требования к серверу

- Linux с Docker Engine ≥ 24 и плагином `docker compose` v2.
- 2 vCPU / 4 ГБ RAM / 20 ГБ диска — минимум для одного инстанса.
- Git (образы собираются из исходников прямо на сервере — реестра образов в проекте нет).
- **Точное время.** Подпись каждого приватного запроса Bybit содержит метку времени, и расхождение
  больше `recv_window` (5 с) отвергается кодом 10002. Движок с недавних пор синхронизирует часы с
  биржей сам, но системный NTP всё равно обязателен — от него зависит и MTProto Telegram:

```bash
timedatectl set-ntp true && timedatectl status | grep -E "synchronized|NTP service"
```

- Ротация логов Docker (иначе журнал контейнеров съест диск):

```bash
cat >/etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
JSON
systemctl restart docker
```

---

## 2. Этап 1 — код и секреты

```bash
git clone <репозиторий> /opt/copytrade && cd /opt/copytrade
cp .env.example .env && chmod 600 .env
```

Сгенерируйте секреты и впишите их в `.env`:

```bash
openssl rand -hex 24   # AI_PROXY_MANAGEMENT_KEY — пароль management API прокси
openssl rand -hex 32   # JWT_SECRET — не короче 32 символов, иначе api не стартует
openssl rand -hex 32   # ENCRYPTION_KEY — шифрование ключей субаккаунтов в БД (ровно 64 hex-символа)
openssl rand -base64 24 # POSTGRES_PASSWORD и ADMIN_PASSWORD (разные!)
```

Заполните остальное:

| Переменная | Значение на проде |
|---|---|
| `TG_APP_API_ID`, `TG_APP_API_HASH` | с https://my.telegram.org |
| `TG_SESSION` | появится на этапе 2 |
| `BYBIT_API_KEY`, `BYBIT_API_SECRET` | ключ Bybit с правом торговли, **с белым списком IP сервера** |
| `BYBIT_NETWORK` | `demo` на первых этапах, `mainnet` — только на этапе 8 |
| `EXECUTION_MODE` | `dry_run` — до этапа 6 |
| `DATABASE_URL` | `postgresql://copytrade:<POSTGRES_PASSWORD>@127.0.0.1:5442/copytrade` |
| `AI_PROXY_URL` | оставьте `http://127.0.0.1:8317` — контейнерам compose подставляет `http://ai-proxy:8317` сам |
| `MEDIA_ROOT` | оставьте пустым — в compose путь задан явно |
| **`TG_CHANNEL_OVERRIDES`** | **обязательно пусто.** Непустое значение = бот слушает ваши тестовые каналы вместо боевых |
| `E2E_TG_SESSION`, `E2E_TG_2FA_PASSWORD` | на проде не нужны (это инструмент e2e) |

> `.env` — единственный носитель всех секретов сразу: строка сессии Telegram равносильна полному
> доступу к аккаунту, ключ Bybit — к торговле. Права `600`, владелец — пользователь, от которого
> запускается compose.

---

## 3. Этап 2 — сессия Telegram

Бот читает каналы не ботом, а **userbot-аккаунтом** (MTProto): только он видит каналы, на которые
подписан человек. Логин интерактивный — нужен код из Telegram и, если включён, облачный пароль.

### Вариант А (рекомендуется): сгенерировать на ноутбуке, перенести строку

На машине, где есть Node 22 и pnpm:

```bash
pnpm install
pnpm tg:login          # спросит номер → код из Telegram → пароль 2FA
```

Скрипт запишет `TG_SESSION=...` в локальный `.env` и **проверит доступ ко всем боевым каналам**
(если аккаунт не подписан — честно откажет). Скопируйте одну строку `TG_SESSION=` в `.env` сервера.

Строка сессии переносима: это ключ авторизации, а не привязка к машине. После первого коннекта с
нового IP Telegram может прислать уведомление о новом входе — это нормально.

### Вариант Б: прямо на сервере

Нужны Node 22 + pnpm на хосте (внутри контейнеров интерактивного логина нет):

```bash
corepack enable && corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm tg:login
```

### Проверка

```bash
pnpm tg:chats          # каналы аккаунта с их «сырыми» id — здесь же видно, под кем работает юзербот
```

---

## 4. Этап 3 — сессия Claude (ai-proxy)

`ai-proxy` ходит в модель по вашей подписке Claude. Авторизация — OAuth: браузер открывает ссылку,
а прокси принимает callback на `127.0.0.1:54545` и завершает обмен на `127.0.0.1:8317`. На сервере
браузера нет, поэтому есть два пути.

Сначала поднимите сам прокси:

```bash
docker compose up -d --build ai-proxy
docker compose ps ai-proxy         # должен стать healthy
```

### Вариант А: SSH-туннель (сервер остаётся единственным источником правды)

С **локальной** машины пробросьте ОБА порта — через них пойдут оба шага редиректа:

```bash
ssh -L 8317:127.0.0.1:8317 -L 54545:127.0.0.1:54545 user@server
```

В этой же SSH-сессии на сервере получите ссылку (Node не нужен, достаточно curl):

```bash
source .env
curl -s -H "X-Management-Key: $AI_PROXY_MANAGEMENT_KEY" \
  "http://127.0.0.1:8317/v0/management/anthropic-auth-url?is_webui=1"
```

Откройте выданный `url` в браузере **локальной** машины и подтвердите доступ. Проверьте результат:

```bash
curl -s -H "X-Management-Key: $AI_PROXY_MANAGEMENT_KEY" \
  http://127.0.0.1:8317/v0/management/auth-files
```

В ответе должен появиться файл с `"provider": "claude"`. Если на сервере есть Node, то же самое
делает `pnpm ai-proxy:login --no-browser` — он ещё и дождётся callback с понятным сообщением.

### Вариант Б: авторизоваться локально и перенести токены

На ноутбуке поднимите только прокси (`pnpm ai-proxy:up && pnpm ai-proxy:login`) — токены лягут в
`./.ai-proxy/auths/`. Скопируйте каталог на сервер:

```bash
rsync -a .ai-proxy/auths/ user@server:/opt/copytrade/.ai-proxy/auths/
```

Токены обновляются прокси автоматически; каталог смонтирован в контейнер, переживает пересборку.

### Проверка живого ответа модели

```bash
curl -s -X POST http://127.0.0.1:8317/v1/messages \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":16,
       "messages":[{"role":"user","content":"reply with: ok"}]}'
```

Ответ с `"content":[{"type":"text","text":"..."}]` = канал 2 (свободный текст) будет разбираться.
HTTP 502 = прокси жив, но подписка не подключена — вернитесь на шаг выше.

---

## 5. Этап 4 — база, api и админка

```bash
docker compose up -d --build postgres api web
docker compose ps                       # postgres/api/web → healthy
docker compose logs api | tail -30      # «миграция ... применена», затем «сервер запущен на :3000»
```

Миграции применяются автоматически при старте `api` (`migrateToLatest` до открытия порта) и, для
надёжности при любом порядке запуска, повторно движком и воркером — отдельной команды не нужно.

Зайдите в админку через туннель с локальной машины:

```bash
ssh -L 5173:127.0.0.1:5173 user@server
# затем открыть http://localhost:5173 — логин/пароль из ADMIN_USERNAME/ADMIN_PASSWORD
```

Пароль админа берётся из `.env` при старте: при первом запуске пользователь создаётся, при
последующих — пароль синхронизируется с `.env`.

---

## 6. Этап 5 — чтение каналов без торговли

```bash
docker compose up -d --build tg-ingest
docker compose logs -f tg-ingest        # «воркер запущен: реалтайм + бэкфилл активны»
```

Что проверить за первые минуты:

- в админке на странице канала появляются сообщения (таймлайн живой);
- каналы засижены и **копирование выключено** — так и должно быть по умолчанию:

```bash
docker compose exec -T postgres psql -U copytrade -d copytrade \
  -c "select c.id, c.title, s.enabled, s.trade_size from channels c join channel_settings s on s.channel_id=c.id order by c.ord;"
```

На этом этапе бот только читает. Ни одного ордера уйти не может: `EXECUTION_MODE=dry_run`, и сверх
того у каналов `enabled=false`.

---

## 7. Этап 6 — движок в dry_run (сутки наблюдения)

```bash
docker compose up -d --build engine
docker compose logs -f engine           # «воркер запущен: пайплайн разбора и исполнения (dry_run)»
```

Включите копирование у ОДНОГО канала в админке (тумблер Copy trading) и оставьте систему на сутки.
В dry_run ордера на биржу не уходят вовсе — пишутся только действия и «симулированные» сделки.

Что смотреть:

```bash
pnpm metrics                            # стоимость AI, кэш-хиты, латентность, действия по причинам
```

- в таблице Actions осмысленные `Executed` и понятные причины у `Skipped`;
- нет лавины `needs_review` (это значит, что разбор systematically не справляется);
- нет сообщений, застрявших в статусе `received`:

```bash
docker compose exec -T postgres psql -U copytrade -d copytrade \
  -c "select status, count(*) from messages where received_at > now() - interval '1 day' group by 1;"
```

---

## 8. Этап 7 — live на demo-сети

Demo Bybit торгует **реальными рыночными ценами виртуальным балансом** — это последняя проверка
перед деньгами, и она проверяет именно исполнение: подпись, идемпотентность, стопы, зеркало позиций.

В `.env`: `BYBIT_NETWORK=demo`, `EXECUTION_MODE=live`, ключи — от demo-аккаунта.

```bash
docker compose up -d --build engine
docker compose logs engine | grep -E "часы биржи|reconcileOnStart|private-ws"
```

Ожидаемо: `часы биржи: поправка N мс`, `auth success`, `subscribe success`.

Если хотите прогнать сценарии осознанно, а не ждать живого сигнала, — на demo доступна e2e-петля
(`docs/e2e/README.md`): свои каналы, свои посты, реальные ордера. **На боевом сервере она не
нужна** и требует непустого `TG_CHANNEL_OVERRIDES`, поэтому гоняйте её на отдельном стенде.

---

## 9. Этап 8 — mainnet

1. Ключ Bybit mainnet с правом торговли и **белым списком IP** сервера; проверьте, что вывод
   средств этим ключом запрещён.
2. В `.env`: `BYBIT_NETWORK=mainnet`, `EXECUTION_MODE=live`.
3. В админке у каждого канала выставьте осознанные лимиты **до** включения тумблера:
   `trade_size` (фолбэк-нотионал), `max_leverage`, `max_symbol_notional` (потолок экспозиции на
   символ — главный предохранитель против «риск 2% × большой депозит»), `no_sl_policy`.
4. Включайте каналы **по одному**, с интервалом в несколько дней.

```bash
docker compose up -d --build engine
docker compose logs -f engine
```

Первые сделки сверьте руками: позиция и стоп в интерфейсе Bybit должны совпадать с карточкой
позиции в админке.

---

## 10. Доступ снаружи (домен + TLS)

По умолчанию всё слушает loopback, и это безопасный дефолт: админка = полный контроль над
торговлей. Если всё же нужен доступ по домену, поставьте перед `web` reverse-proxy с TLS
(Caddy/nginx) и учтите **два условия — без них вход и realtime сломаются**:

1. **Кука сессии.** `docker-compose.yml` принудительно ставит api `NODE_ENV: development`, потому
   что весь стек ходит по http, а `Secure`-кука по http браузером не сохраняется. За TLS нужно
   вернуть `NODE_ENV: production` — иначе кука уйдёт без флага `Secure`.
2. **Origin вебсокета.** `apps/api/src/realtime/realtime.gateway.ts` жёстко разрешает
   `http://localhost:5173`:

```ts
const DEV_ORIGIN = 'http://localhost:5173'
@WebSocketGateway({ cors: { origin: DEV_ORIGIN, credentials: true } })
```

   С реального домена браузер пришлёт свой Origin, и хендшейк будет отклонён — таблицы перестанут
   обновляться в реальном времени (REST при этом работает, поэтому дефект выглядит как «данные
   обновляются только по F5»). Минимальная правка — вынести origin в переменную окружения:

```ts
const ALLOWED_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
```

   и задать `WEB_ORIGIN=https://bot.example.com` в `.env`.

Плюс обязательное: закрыть 5173/5442/8317 файрволом снаружи, включить в reverse-proxy
rate-limit на `/api/auth/login`.

---

## 11. Эксплуатация

### Обновление

```bash
cd /opt/copytrade
git pull
docker compose up -d --build            # миграции применятся сами при старте api
docker compose ps && docker compose logs --tail 50 api engine tg-ingest
```

Точечно (например только движок): `docker compose up -d --build engine`.

### Откат

```bash
git checkout <прошлый тег/коммит>
docker compose up -d --build
```

⚠️ Миграции схемы вперёд-совместимы, но не откатываются автоматически. Если релиз добавлял
миграцию, откат кода на версию, которая её не знает, требует ручного `pnpm --filter api migrate:up`
соответствующей ревизии или восстановления из бэкапа.

### Бэкапы (минимум ежедневно)

```bash
# база
docker compose exec -T postgres pg_dump -U copytrade copytrade | gzip > /backup/db-$(date +%F).sql.gz
# секреты и токены (без них восстановление бессмысленно)
tar czf /backup/secrets-$(date +%F).tgz .env .ai-proxy/auths
# медиа сообщений
tar czf /backup/media-$(date +%F).tgz var/media
```

Восстановление базы:

```bash
gunzip -c /backup/db-YYYY-MM-DD.sql.gz | docker compose exec -T postgres psql -U copytrade -d copytrade
```

### Мониторинг

- `docker compose ps` — у `postgres/api/web/ai-proxy` есть healthcheck; у `engine` и `tg-ingest`
  его нет, их состояние смотрится по логам и по свежести данных;
- `curl -s http://127.0.0.1:5173/api/health` → `{"status":"ok"}`;
- «данные не обновляются» чаще всего означает одно из трёх: ушли часы (`10002` в логе движка),
  отвалился приватный WS (нет `auth success` после реконнекта), встал tg-ingest (нет новых
  сообщений). Первое теперь лечится само, остальные два видны в логах;
- `pnpm metrics` — стоимость AI и разбивка действий по причинам.

> Команды `pnpm metrics` / `pnpm tg:*` требуют Node 22 + pnpm НА ХОСТЕ (это скрипты репозитория, а
> не контейнеры). Если ставить Node на прод-сервер не хочется — пробросьте базу туннелем
> (`ssh -L 5442:127.0.0.1:5442 user@server`) и запускайте их с ноутбука: `.env` там должен
> указывать на `127.0.0.1:5442`.

### Аварийная остановка

| Ситуация | Действие |
|---|---|
| Сомнительный сигнал/канал | выключить тумблер Copy trading у канала в админке — разбор продолжится, ордера перестанут уходить |
| Нужно остановить всю торговлю | `docker compose stop engine` — ингест и админка продолжат работать |
| Нужно закрыть позиции | на mainnet — руками в интерфейсе Bybit (инструмент `pnpm e2e flatten` намеренно отказывается работать на mainnet) |
| Полная остановка | `docker compose down` (данные в томе и на диске сохраняются) |

---

## 12. Чеклист перед первым live-запуском

- [ ] `TG_CHANNEL_OVERRIDES` пуст;
- [ ] `.env` с правами 600, секреты сгенерированы, а не взяты из примера;
- [ ] ключ Bybit ограничен по IP, вывод средств запрещён;
- [ ] `timedatectl` показывает синхронизацию времени;
- [ ] сессия Telegram видит все боевые каналы (`pnpm tg:chats`);
- [ ] `auth-files` прокси содержит запись `claude`, тестовый запрос к `/v1/messages` отвечает 200;
- [ ] сутки в `dry_run` без застрявших `received` и без лавины `needs_review`;
- [ ] у каналов выставлены `trade_size`, `max_leverage`, `max_symbol_notional`;
- [ ] бэкап базы и `.env` снят и проверен восстановлением;
- [ ] каналы включаются по одному, первые сделки сверены с интерфейсом Bybit.
