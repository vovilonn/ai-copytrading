# Слой приёма Telegram (GramJS / MTProto userbot) — верификация

Окружение: `telegram` (GramJS) 2.26.x, Node 24, MTProto LAYER 198. Все проверки — под рабочей
сессией из `.env`, read-only: сообщения не отправлялись, сессия не инвалидировалась.

Резолв сущностей: у сессии нет `access_hash` для «голых» id, поэтому перед `getEntity(id)`
обязателен разовый `client.getDialogs({limit})`.

---

## 1. Фильтр топика: `replyToTopId`, а не `replyToMsgId`

Структура `Api.MessageReplyHeader`: `forumTopic`, `replyToMsgId`, `replyToTopId`, `quote*`.

Живые распечатки:

```
221445 (ответ на 221443):  replyToMsgId=221443  replyToTopId=173666  forumTopic=true
221452 (пост в топик):     replyToMsgId=173666  replyToTopId=null    forumTopic=true
221443 (сам сигнал):       replyToMsgId=173666  replyToTopId=null    forumTopic=true
221354 (ответ на 221348):  replyToMsgId=221348  replyToTopId=173666  forumTopic=true
221378 (альбом, корень):   replyToMsgId=173666  replyToTopId=null    forumTopic=true
```

Инвариант из доки `core.telegram.org/api/forum`: `top_msg_id` (= `replyToTopId`) присутствует
тогда и только тогда, когда отвечают на сообщение **внутри** топика.

```ts
function topicOf(m: Api.Message, topicId: number): 'root' | 'reply' | 'other' {
  const r = m.replyTo
  if (!(r instanceof Api.MessageReplyHeader) || !r.forumTopic) return 'other'
  const t = r.replyToTopId ?? r.replyToMsgId   // фактический топик
  if (t !== topicId) return 'other'
  return r.replyToTopId == null ? 'root' : 'reply'
}
```

**`NewMessage({chats})` фильтрует только по `chatId`** — топик там не учитывается, фильтр
применяется вручную. Для бэкфилла топик фильтруется на сервере: `getMessages(forum, {replyTo: 173666})`.

---

## 2. Альбомы

Один альбом = **N отдельных апдейтов** (по одному на фото). GramJS не склеивает их в
`NewMessage`. Встроенный `Album` копит по `groupedId` и диспатчит через 500 мс.

Подпись лежит на одном элементе, не обязательно первом. В форуме встречаются альбомы
**вообще без подписи** (`221378–221381`, `221391–221392`).

Свой буфер (окно 600 мс) даёт единый путь для live и бэкфилла. Если использовать встроенный
`Album`, в `NewMessage` нужно пропускать сообщения с `groupedId`, иначе двойная обработка.

---

## 3. Медиа

`client.downloadMedia(message, {})` возвращает `Buffer` без записи на диск, по умолчанию —
наибольший размер.

Фото Telegram крошечные: ~98 КБ / 1128 px — на порядок ниже лимитов Anthropic (5 МБ, 8000 px).
Ресайз не нужен.

**Видео** в дампе есть (`221436`, `video/mp4`, 4 МБ). В vision не отправить. Брать статический
thumbnail:

```
downloadMedia(vid, {thumb: 0})  -> 757 B    (stripped, бесполезен)
downloadMedia(vid, {thumb: 1})  -> 14 KB    (реальный JPEG 320x176) ← брать
downloadMedia(vid, {thumb: -1}) -> 4.1 MB   (скачал ВЕСЬ mp4!)
```

`thumb: -1` — не «наибольший thumb», а весь документ. Использовать
`doc.thumbs.find(t => t.className === 'PhotoSize')`. Стикеры (`application/x-tgsticker`) пропускать.

---

## 4. Бэкфилл

```ts
const msgs = await client.getMessages(entity, {
  minId: lastSeenId,   // строго новее обработанного
  reverse: true,       // от старых к новым
  limit: 200,
  ...(topicId ? { replyTo: topicId } : {}),
})
```

GetHistory дешёвый; безопасно тянуть сотни сообщений. GramJS сам ставит паузы (`waitTime`).
`floodSleepThreshold: 60` — FloodWait до 60 с библиотека проспит сама.

Бэкфилл на границе неизбежно пересекается с live-событиями, поэтому обработка обязана быть
идемпотентной по `(channel_id, message_id)`. Курсор двигать только вперёд: `GREATEST(last_seen, id)`.

---

## 5. Реконнект, дубли, FloodWait, «Error: TIMEOUT»

**`catchUp()` в GramJS 2.26.x — пустая заглушка (`// TODO`)**, и во всём `client/` нет
`getDifference`/`getChannelDifference`. Следствия:

- пропущенные во время обрыва апдейты **библиотека не восстанавливает** → нужен наш бэкфилл;
- одно и то же сообщение может продиспатчиться дважды → **дедуп обязателен**.

`FloodWaitError` имеет поле `.seconds`. GramJS спит и ретраит сам, если `X ≤ floodSleepThreshold`
(60 с); иначе бросает — ловить и спать `err.seconds` с джиттером.

**«Error: TIMEOUT» из `updates.js:250` — это keepalive-пинг**, а не фатальная ошибка.
`_updateLoop` шлёт `PingDelayDisconnect` каждые 9 с с таймаутом 10 с; если понг не пришёл,
логируется TIMEOUT и вызывается `_sender.reconnect()`. Процесс переживает.

Реальные дефолты (`telegramBaseClient.js`): `autoReconnect: true`, `connectionRetries: Infinity`
(в `.d.ts` устаревший комментарий «5»), `reconnectRetries: Infinity`, `retryDelay: 1000`.

Гасить шум: `client.setLogLevel(LogLevel.WARN)` — реконнект при этом сохраняется. Обязателен
`process.on('unhandledRejection')`, чтобы одиночный отклонённый пинг не ронял процесс.
Бэкфилл — после каждого реконнекта.

---

## 6. Редактирование — норма, а не редкость

`Api.UpdateEditChannelMessage` → GramJS `EditedMessage` → `EditedMessageEvent` с `message.editDate`.

**Из 25 последних сообщений топика 24 имеют `editDate`.** Автор регулярно дописывает сигналы.
Обрабатывать правки обязательно.

Политика: хранить `(message_id, edit_date, parsed_version)`. На правку — переразобрать и
сравнить с исполненной версией:

- изменились SL/TP/entry ещё не набранной сделки → переставить ордера;
- сделка уже открыта, правка косметическая или постфактум-комментарий → только лог;
- добавлена отмена / «не актуально» → трактовать как сигнал закрытия;
- изменились числа уже исполненного действия → `needs_review`.

Повторный `editDate`, равный обработанному, — игнорировать.

---

## 7. Удаление

`Api.UpdateDeleteChannelMessages` → `DeletedMessage` → `{deletedIds, peer}`. Событие не
стопроцентно надёжно (Telegram не всегда уведомляет).

Позиции **не закрывать автоматически**: удаление сообщения не отменяет рыночный риск.
Неисполненную лимитку по удалённому сигналу — снять. По открытой позиции — алерт оператору.

---

## 8. Порядок доставки

Строгих гарантий межсобытийного порядка нет, тем более при реконнекте и бэкфилле.

**Упорядочивать по `message.id`, не по `date`.** `id` монотонен внутри канала; `date` кусковат:
у всех элементов альбома он одинаков, правки его не двигают.

---

## 9. Reply вне выборки

Транзитивный подъём до корня ветки с точечной догрузкой `getMessages({ids: [parentId]})` и
защитой от циклов. Полная персистентная история не нужна: LRU-кэш последних сообщений топика
плюс догрузка по id закрывают пробелы. Родитель недоступен (удалён) → трактовать сообщение как
самостоятельное и логировать «orphan reply».

---

## 10. Сессия и деплой

`StringSession` — полноценный auth-key. При рестарте контейнера повторный логин не нужен.

**Одна MTProto-сессия на аккаунт — жёсткое требование.** Два клиента с одной сессией → потеря
апдейтов и риск `AUTH_KEY_DUPLICATED`. Ингест-воркер работает ровно в одной реплике; API
масштабируется отдельно. Дедуп `(channel_id, message_id)` страхует от двойной обработки на стыке
рестарта и бэкфилла, но не решает проблему двух живых сессий — её решает только singleton.

---

## 11. Лимиты и бан

Банит **исходящая** активность: рассылки, добавление в контакты, агрессивные `resolveUsername`.
Чистое чтение (updates + `getMessages` + `downloadMedia` по каналам, где аккаунт состоит) —
низкий риск. Уважать `FLOOD_WAIT_X`, не держать 2+ активных сессий, аккаунт — на отдельном номере.

Точные числовые лимиты Telegram не публикует. [НЕ ПРОВЕРЕНО экспериментом — по практике MTProto.]

---

## Сводка

| Пункт | Вывод |
|---|---|
| Топик root vs reply | `replyToTopId == null` → корень; `!= null` → ответ. Live-подтверждено |
| Альбом | N апдейтов, склейка по `groupedId`; подписи может не быть вовсе |
| Медиа | фото → Buffer (~98 КБ); видео → только `thumb` с `className === 'PhotoSize'` |
| Бэкфилл | `getMessages({minId, reverse, replyTo})`, батч ≤ 200 |
| Реконнект | `catchUp` = no-op, gap-recovery только наш; дубли возможны |
| «Error: TIMEOUT» | keepalive-пинг, штатно, ведёт к auto-reconnect |
| Edit | 24/25 сообщений имеют `editDate` — правки норма |
| Delete | позиции авто не закрывать |
| Порядок | по `message.id`, не по `date` |
| Сессия | ровно одна реплика ингеста на аккаунт |
