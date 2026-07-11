import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network } from 'shared/domain.js'
import { applyMarkPriceTick, openPositionSymbols } from './apply-tick.js'
import { parseMarkPriceTick } from './ticker-message.js'

// Публичный WS (без ключа) — testnet/mainnet строго разные хосты (research bybit-execution.md
// §12/§13, тот же приём разделения сетей, что и apps/api/src/instruments/bybit-client.ts).
const WS_HOSTS: Record<Network, string> = {
  testnet: 'wss://stream-testnet.bybit.com/v5/public/linear',
  mainnet: 'wss://stream.bybit.com/v5/public/linear',
}

const THROTTLE_MS = 1000
// Полировка Б (task-11-brief.md): при 76+ открытых позициях троттлинг ТИКА ~1/сек на символ
// (THROTTLE_MS выше) всё ещё даёт ~76 WS-событий/сек суммарно по всем символам — ощутимо для UI
// (каждое приводит к патчу React Query кэша на фронте). positions.mark_price в БД по-прежнему
// пишем на каждый прошедший THROTTLE_MS тик (дёшево, один UPDATE), а вот сам эмит position.upsert
// в domain_events (= WS-рассылка, outbox api публикует НЕМЕДЛЕННО по NOTIFY) троттлим ОТДЕЛЬНО,
// реже — не чаще раза в EMIT_THROTTLE_MS на символ.
const EMIT_THROTTLE_MS = 2000
const SUBSCRIPTION_REFRESH_MS = 5000
// Bybit требует периодический ping, иначе разрывает публичное WS-соединение по таймауту
// (задокументировано в v5 WS connect-доке; не покрыто research'ем §12, но проверено эмпирически
// в scratchpad ws.py — соединение без пинга падало по немолчанию ~30-60с).
const PING_INTERVAL_MS = 20_000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

/** Разница множеств подписки — чистая функция, отдельно тестируется без реального сокета. */
export function diffSubscriptions(
  subscribed: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): { toSubscribe: string[]; toUnsubscribe: string[] } {
  const toSubscribe = [...desired].filter((s) => !subscribed.has(s))
  const toUnsubscribe = [...subscribed].filter((s) => !desired.has(s))
  return { toSubscribe, toUnsubscribe }
}

/**
 * Троттлинг "не чаще ~1 обновления в секунду на символ" (задача 10) — leading-edge: первый тик
 * после паузы применяется сразу, все следующие в пределах throttleMs — отбрасываются (реальный
 * поток восстановит актуальную цену следующим же тиком, задержка не накапливается).
 */
export function shouldApplyTick(
  lastAppliedAt: ReadonlyMap<string, number>,
  symbol: string,
  now: number,
  throttleMs = THROTTLE_MS,
): boolean {
  const last = lastAppliedAt.get(symbol) ?? 0
  return now - last >= throttleMs
}

export interface TickersFeedLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Публичный WS-фид Bybit `tickers.<symbol>` (task-10-brief.md, research §12): без ключа, доступен
 * и в dry-run. Держит подписку синхронизированной с реально открытыми позициями — периодически
 * перечитывает набор символов из БД (openPositionSymbols) и досылает subscribe/unsubscribe на
 * разницу (diffSubscriptions). На каждый тик с markPrice — троттлинг ~1/сек на символ
 * (shouldApplyTick), дальше applyMarkPriceTick пишет mark_price/unrealised_pnl; публикация
 * position.upsert в WS троттлится ОТДЕЛЬНО и реже — ~раз в EMIT_THROTTLE_MS на символ (задача 11,
 * полировка Б), тем же shouldApplyTick с другой картой таймстампов и порогом. Реконнект с
 * экспоненциальным backoff — тот же паттерн, что и LISTEN-клиент в main.ts/outbox.publisher.ts.
 */
export class TickersFeed {
  private ws: WebSocket | null = null
  private stopped = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs = RECONNECT_BASE_MS
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly subscribed = new Set<string>()
  private readonly lastAppliedAt = new Map<string, number>()
  // Отдельная от lastAppliedAt карта (полировка Б, task-11-brief.md): DB-запись и WS-эмит
  // троттлятся с разным периодом (THROTTLE_MS vs EMIT_THROTTLE_MS), общий таймстамп смешал бы их.
  private readonly lastEmittedAt = new Map<string, number>()

  constructor(
    private readonly db: Kysely<DB>,
    private readonly network: Network,
    private readonly log: TickersFeedLogger = console,
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
    this.refreshTimer = setInterval(() => {
      this.refreshSubscriptions().catch((err) => this.log.error('[tickers-feed] обновление подписок:', err))
    }, SUBSCRIPTION_REFRESH_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.refreshTimer = null
    this.reconnectTimer = null
    this.pingTimer = null
    this.subscribed.clear()
    this.ws?.close()
    this.ws = null
  }

  private connect(): void {
    if (this.stopped) return
    const url = WS_HOSTS[this.network]
    const ws = new WebSocket(url)
    this.ws = ws

    ws.addEventListener('open', () => {
      this.log.log(`[tickers-feed] подключен к ${url}`)
      this.reconnectDelayMs = RECONNECT_BASE_MS
      // Bybit не переносит подписки между соединениями — после (ре)коннекта досылаем всё заново.
      this.subscribed.clear()
      this.refreshSubscriptions().catch((err) => this.log.error('[tickers-feed] подписка после коннекта:', err))
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.sendSafe({ op: 'ping' }), PING_INTERVAL_MS)
    })

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(String(event.data)).catch((err) => this.log.error('[tickers-feed] обработка тика:', err))
    })

    // 'close' у нативного WebSocket следует и за штатным, и за аварийным завершением (в т.ч.
    // после 'error') — реконнект планируется только там, чтобы не задвоить таймер.
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      this.log.warn('[tickers-feed] ошибка соединения (ожидаю close для реконнекта)')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendSafe(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private async refreshSubscriptions(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const desired = new Set(await openPositionSymbols(this.db))
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(this.subscribed, desired)

    if (toSubscribe.length > 0) {
      this.sendSafe({ op: 'subscribe', args: toSubscribe.map((s) => `tickers.${s}`) })
      toSubscribe.forEach((s) => this.subscribed.add(s))
    }
    if (toUnsubscribe.length > 0) {
      this.sendSafe({ op: 'unsubscribe', args: toUnsubscribe.map((s) => `tickers.${s}`) })
      toUnsubscribe.forEach((s) => this.subscribed.delete(s))
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    const tick = parseMarkPriceTick(raw)
    if (!tick) return

    const now = Date.now()
    if (!shouldApplyTick(this.lastAppliedAt, tick.symbol, now)) return
    this.lastAppliedAt.set(tick.symbol, now)

    // Полировка Б: решаем ОТДЕЛЬНО от DB-троттлинга выше, публиковать ли position.upsert в этот
    // раз (~раз в EMIT_THROTTLE_MS на символ) — mark_price в БД обновится в любом случае.
    const shouldEmit = shouldApplyTick(this.lastEmittedAt, tick.symbol, now, EMIT_THROTTLE_MS)
    if (shouldEmit) this.lastEmittedAt.set(tick.symbol, now)

    const emitted = await applyMarkPriceTick(this.db, tick.symbol, tick.markPrice, { emit: shouldEmit })
    // Тот же приём, что и pipeline.ts/outbox.publisher.ts: NOTIFY после успешной записи —
    // будит OutboxPublisher api немедленно, не дожидаясь его 5-секундного периодического опроса.
    if (emitted) await sql`SELECT pg_notify('domain_events', '')`.execute(this.db)
  }
}
