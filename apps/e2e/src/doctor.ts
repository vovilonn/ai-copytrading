import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { BybitRestClient } from 'engine/bybit/rest-client.js'
import { channelState, pendingMessages } from './db.js'
import { snapshot } from './exchange.js'
import type { TgPoster } from './tg.js'
import type { E2eConfig } from './env.js'

/**
 * Преflight перед прогоном: «всё ли готово к тому, что мой пост станет реальным ордером».
 *
 * Каждая проверка отвечает на конкретный вопрос отладки, который иначе всплыл бы посреди
 * сценария в виде необъяснимой тишины: не запущен ingest — пост не доедет до БД; не запущен
 * engine — сообщение вечно в 'received'; выключено копирование — всё уходит в skipped
 * (copy_disabled); курсор канала позади реальных сообщений — бот при старте переиграет старую
 * историю и наоткрывает сделок «из прошлого».
 */

const exec = promisify(execFile)

export type CheckLevel = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  level: CheckLevel
  detail: string
}

export interface DoctorDeps {
  config: E2eConfig
  db: Kysely<DB>
  rest: BybitRestClient
  poster: TgPoster
}

export async function doctor(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = []
  const { config } = deps

  // ── Режим ───────────────────────────────────────────────────────────────────────────────────
  checks.push({
    name: 'режим исполнения',
    level: config.executionMode === 'live' ? 'ok' : 'warn',
    detail:
      config.executionMode === 'live'
        ? 'EXECUTION_MODE=live — ордера уходят на биржу'
        : `EXECUTION_MODE=${config.executionMode} — ордера НЕ уходят на биржу (проверятся только БД/парсинг)`,
  })
  checks.push({
    name: 'сеть Bybit',
    level: config.network === 'demo' ? 'ok' : 'warn',
    detail: `BYBIT_NETWORK=${config.network}${config.network === 'demo' ? ' (виртуальный баланс, реальные цены)' : ''}`,
  })

  // ── Контейнеры ──────────────────────────────────────────────────────────────────────────────
  checks.push(await checkContainers())
  checks.push(await checkClockSkew())

  // ── БД ──────────────────────────────────────────────────────────────────────────────────────
  try {
    const migrations = await sql<{ count: string }>`SELECT count(*)::text AS count FROM kysely_migration`.execute(deps.db)
    checks.push({ name: 'postgres', level: 'ok', detail: `подключение есть, миграций применено: ${migrations.rows[0]?.count ?? '?'}` })
  } catch (err) {
    checks.push({ name: 'postgres', level: 'fail', detail: `нет подключения по DATABASE_URL: ${String(err)}` })
    return checks // без БД остальные проверки бессмысленны
  }

  const pending = await pendingMessages(deps.db)
  checks.push({
    name: 'очередь движка',
    level: pending.length === 0 ? 'ok' : 'warn',
    detail:
      pending.length === 0
        ? 'необработанных сообщений нет'
        : `движок ещё не разобрал: ${pending.map((p) => `канал ${p.channelId} ${p.status}×${p.count}`).join(', ')}`,
  })

  // ── Telegram + каналы ───────────────────────────────────────────────────────────────────────
  // Все обращения к Telegram — в ОДНОМ соединении: пока клиент e2e подключён, tg-ingest со той же
  // сессией не получает realtime (см. комментарий в tg.ts), поэтому окно держим коротким.
  const telegram = await deps.poster
    .withConnection(async () => {
      const me = await deps.poster.me()
      const channels = []
      for (const channel of config.channels) {
        channels.push({
          slot: channel.slot,
          described: await deps.poster.describe(channel.slot),
          lastId: await deps.poster.lastMessageId(channel.slot),
        })
      }
      return { me, channels }
    })
    .catch((err: unknown) => {
      checks.push({ name: 'telegram-сессия', level: 'fail', detail: `сессия не работает: ${String(err)}` })
      return null
    })
  if (!telegram) return checks

  checks.push({
    name: 'telegram-сессия',
    level: 'ok',
    detail: `юзербот ${telegram.me.name}${telegram.me.username ? ` (@${telegram.me.username})` : ''}${telegram.me.phone ? `, +${telegram.me.phone}` : ''}`,
  })
  checks.push({
    name: 'сессия постера',
    level: deps.poster.sharesWorkerSession ? 'warn' : 'ok',
    detail: deps.poster.sharesWorkerSession
      ? 'E2E_TG_SESSION не задан — постер работает на ОБЩЕЙ с tg-ingest сессии: воркер теряет realtime и посты доезжают только бэкфиллом. Выполните `pnpm e2e session`'
      : 'E2E_TG_SESSION задан — у постера свой auth-key, realtime воркера не страдает',
  })

  for (const channel of config.channels) {
    try {
      const probed = telegram.channels.find((c) => c.slot === channel.slot)!
      const described = probed.described
      const lastId = probed.lastId
      const state = await channelState(deps.db, channel.id)

      if (!state) {
        checks.push({
          name: `канал ${channel.slot} (${channel.adapterId})`,
          level: 'fail',
          detail: `«${described.title}» есть в Telegram, но НЕ засижен в БД — запустите api/tg-ingest`,
        })
        continue
      }

      const problems: string[] = []
      if (!described.canPost) problems.push('нет прав на постинг')
      if (!state.enabled) problems.push('копирование выключено (channel_settings.enabled=false) — всё уйдёт в skipped')
      if (state.status !== 'active') problems.push(`статус канала '${state.status}'`)
      if (state.lastSeenMessageId < lastId) {
        problems.push(`курсор ${state.lastSeenMessageId} позади последнего сообщения ${lastId} — при старте бот переиграет историю (лечится \`pnpm e2e reset\`)`)
      }

      checks.push({
        name: `канал ${channel.slot} (${channel.adapterId})`,
        level: problems.length === 0 ? 'ok' : 'warn',
        detail:
          `«${described.title}» ${described.kind}, id=${channel.id}, курсор=${state.lastSeenMessageId}/${lastId}, ` +
          `trade_size=${state.tradeSize}, max_notional=${state.maxSymbolNotional ?? '—'}, плечо≤${state.maxLeverage}` +
          (problems.length ? ` | ${problems.join('; ')}` : ''),
      })
    } catch (err) {
      checks.push({ name: `канал ${channel.slot}`, level: 'fail', detail: `не резолвится: ${String(err)}` })
    }
  }

  // ── Bybit ───────────────────────────────────────────────────────────────────────────────────
  try {
    const state = await snapshot(deps.rest)
    const dirty = state.positions.length > 0 || state.orders.length > 0
    checks.push({
      name: 'аккаунт bybit',
      level: dirty ? 'warn' : 'ok',
      detail:
        `equity=${new Intl.NumberFormat('ru-RU').format(Number(state.totalEquity))} (USDT ${new Intl.NumberFormat('ru-RU').format(Number(state.usdtBalance))}), ` +
        `позиций: ${state.positions.length}${state.positions.length ? ` (${state.positions.map((p) => `${p.symbol} ${p.side} ${p.size}`).join(', ')})` : ''}, ` +
        `живых ордеров: ${state.orders.length}` +
        (dirty ? ' | аккаунт не пуст — `pnpm e2e reset` выровняет' : ''),
    })
  } catch (err) {
    checks.push({ name: 'аккаунт bybit', level: 'fail', detail: `REST недоступен: ${String(err)}` })
  }

  // ── ai-proxy (нужен каналу 2: свободный текст разбирает модель) ──────────────────────────────
  checks.push(await checkAiProxy(config.aiProxyUrl))

  // ── Инструменты (кэш листинга, из него берутся шаг цены/лота) ───────────────────────────────
  const instruments = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM instruments WHERE network = ${config.network}`.execute(deps.db)
  const instrumentCount = Number(instruments.rows[0]?.count ?? '0')
  checks.push({
    name: 'кэш инструментов',
    level: instrumentCount > 0 ? 'ok' : 'fail',
    detail: instrumentCount > 0 ? `${instrumentCount} символов для сети ${config.network}` : `для сети ${config.network} нет ни одного инструмента — api их обновляет при старте`,
  })

  return checks
}

async function checkContainers(): Promise<Check> {
  const expected = ['postgres', 'api', 'tg-ingest', 'engine', 'ai-proxy']
  try {
    const { stdout } = await exec('docker', ['compose', 'ps', '--format', 'json'])
    // `docker compose ps --format json` отдаёт по JSON-объекту на строку (не единый массив).
    const rows = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { Service: string; State: string; Health?: string })
    const down = expected.filter((service) => {
      const row = rows.find((r) => r.Service === service)
      return !row || row.State !== 'running'
    })
    return {
      name: 'контейнеры',
      level: down.length === 0 ? 'ok' : 'fail',
      detail:
        down.length === 0
          ? rows.map((r) => `${r.Service}:${r.Health || r.State}`).join(', ')
          : `не запущены: ${down.join(', ')} — поднимите стек \`docker compose up -d\``,
    }
  } catch (err) {
    return { name: 'контейнеры', level: 'warn', detail: `не удалось опросить docker compose: ${String(err)}` }
  }
}

/**
 * Часы контейнера против часов Bybit. Подпись каждого приватного запроса содержит timestamp, а
 * биржа отвергает всё, что разошлось больше чем на recv_window (5000 мс, rest-client.ts):
 * retCode 10002. Живой случай этого прогона: после сна ноутбука VM Docker Desktop уехала на 5
 * секунд — движок молча перестал писать снапшоты баланса, а приватный WS (его auth тоже подписан
 * временем) рисковал не авторизоваться, из-за чего зеркало позиций переставало обновляться.
 * Симптом «всё запущено, но данные не обновляются» — ровно тот, который иначе ищут часами.
 */
async function checkClockSkew(): Promise<Check> {
  try {
    const [{ stdout }, res] = await Promise.all([
      exec('docker', ['compose', 'exec', '-T', 'engine', 'node', '-e', 'console.log(Date.now())']),
      fetch('https://api-demo.bybit.com/v5/market/time', { signal: AbortSignal.timeout(5000) }),
    ])
    const body = (await res.json()) as { result: { timeNano: string } }
    const exchangeMs = Number(body.result.timeNano.slice(0, 13))
    const containerMs = Number(stdout.trim())
    const skew = exchangeMs - containerMs
    const level: CheckLevel = Math.abs(skew) < 2000 ? 'ok' : Math.abs(skew) < 5000 ? 'warn' : 'fail'
    return {
      name: 'часы контейнера',
      level,
      detail:
        `расхождение с биржей ${skew > 0 ? '+' : ''}${skew} мс` +
        (level === 'ok'
          ? ''
          : ' — подпись приватных запросов отвергается кодом 10002 (recv_window 5000 мс). Лечится синхронизацией времени VM Docker (перезапуск Docker Desktop)'),
    }
  } catch (err) {
    return { name: 'часы контейнера', level: 'warn', detail: `не удалось сверить время: ${String(err)}` }
  }
}

async function checkAiProxy(baseUrl: string): Promise<Check> {
  const degraded = (detail: string): Check => ({
    name: 'ai-proxy',
    level: 'warn',
    detail: `${detail} — канал 2 (свободный текст) будет уходить в needs_review/ai_unavailable`,
  })
  try {
    // НАСТОЯЩИЙ запрос той же моделью и тем же эндпоинтом, что и движок (ai/client.ts): «порт
    // отвечает» ничего не доказывает — прокси жив и при протухшей авторизации апстрима, только
    // отдаёт 502 на каждый разбор. 16 токенов стоят доли цента, зато канал 2 проверен по-настоящему.
    const started = Date.now()
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ответь одним словом: ок' }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return degraded(`${baseUrl} отвечает HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { content?: Array<{ text?: string }> }
    const text = body.content?.[0]?.text ?? ''
    return { name: 'ai-proxy', level: 'ok', detail: `${baseUrl}: живой ответ модели за ${Date.now() - started} мс («${text.trim().slice(0, 20)}»)` }
  } catch (err) {
    return degraded(`${baseUrl} недоступен (${String(err)})`)
  }
}
