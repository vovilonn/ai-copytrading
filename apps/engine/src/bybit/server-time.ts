/**
 * Часы биржи.
 *
 * ЗАЧЕМ. Каждый приватный запрос Bybit подписывается временной меткой и отвергается, если она
 * разошлась с серверной больше чем на `recv_window` (5000 мс) — retCode 10002. Локальные часы для
 * этого негодны: живой случай e2e — после сна ноутбука VM Docker Desktop ушла на ~5 секунд, и
 * движок молча перестал писать снапшоты баланса, а зеркало позиций перестало обновляться. Внешне
 * при этом всё «работает»: контейнеры живы, сообщения разбираются, ошибок в UI нет.
 *
 * РЕШЕНИЕ. Один раз (и далее по TTL) спрашиваем у биржи её время публичным `GET /v5/market/time`
 * и держим ПОПРАВКУ. Подпись считается по `Date.now() + offset`, поэтому дрейф хоста перестаёт
 * что-либо значить: смещается всё разом и предсказуемо. Тот же источник времени используется для
 * `expires` в auth приватного WS — там подпись ровно с той же проблемой.
 *
 * Задержка сети компенсируется серединой интервала запроса: offset = server − (t0 + t1)/2.
 */

/** Возвращает время сервера в миллисекундах. Инжектируется ради тестов. */
export type ServerTimeFetcher = () => Promise<number>

export interface ServerClockOptions {
  /** Как часто пересинхронизироваться (дефолт 5 минут: дрейф кварца ничтожен, а сон VM ловится
   *  либо этим интервалом, либо принудительной синхронизацией по 10002). */
  ttlMs?: number
  /** Источник локального времени — подменяется в тестах. */
  now?: () => number
}

const DEFAULT_TTL_MS = 5 * 60_000

export class ServerClock {
  private offsetMs = 0
  private syncedAtMs = 0
  /** Отдельный флаг, а НЕ `syncedAtMs === 0`: ноль — валидная метка времени (и обычное значение
   *  подменённых часов в тестах), путать «ни разу не синхронизировались» с ней нельзя. */
  private everSynced = false
  private inflight: Promise<void> | null = null
  private readonly ttlMs: number
  private readonly localNow: () => number

  constructor(
    private readonly fetchServerMs: ServerTimeFetcher,
    options: ServerClockOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.localNow = options.now ?? Date.now
  }

  /** Текущее время БИРЖИ по нашим часам с поправкой. */
  nowMs(): number {
    return this.localNow() + this.offsetMs
  }

  /** Текущая поправка (сервер − локальные часы), мс. Для диагностики/логов. */
  get offset(): number {
    return this.offsetMs
  }

  /**
   * Освежает поправку, если она устарела (дешёвая проверка перед каждой подписью).
   *
   * ВАЖНО: пока часы ни разу не синхронизировали ЯВНО (`sync()`), проактивная синхронизация не
   * делается вовсе. Так «походы в сеть за временем» включает тот, кто действительно торгует
   * (main.ts на старте live-рантайма), а юнит-тесты, dry-run и офлайн-прогоны остаются без
   * единого лишнего запроса. Аварийный путь это не ослабляет: retCode 10002 форсирует sync().
   */
  async ensureFresh(): Promise<void> {
    if (!this.everSynced) return
    if (this.localNow() - this.syncedAtMs < this.ttlMs) return
    await this.sync()
  }

  /**
   * Принудительная синхронизация. Single-flight: параллельные подписи не должны множить запросы.
   * Сбой похода за временем НЕ бросается наружу — прежняя поправка остаётся в силе, а сам
   * запрос упадёт (или не упадёт) на общих основаниях: терять торговлю из-за недоступного
   * эндпоинта времени хуже, чем работать со слегка устаревшей поправкой.
   */
  async sync(): Promise<void> {
    this.inflight ??= this.doSync().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doSync(): Promise<void> {
    const startedAt = this.localNow()
    try {
      const serverMs = await this.fetchServerMs()
      const finishedAt = this.localNow()
      // Середина интервала — лучшая оценка «локального времени в момент ответа сервера».
      this.offsetMs = Math.round(serverMs - (startedAt + finishedAt) / 2)
      this.syncedAtMs = finishedAt
      this.everSynced = true
    } catch {
      // Не даём часам «застрять» в вечных попытках синхронизации на каждом запросе: помечаем
      // попытку выполненной, следующая произойдёт по TTL.
      this.syncedAtMs = this.localNow()
      this.everSynced = true
    }
  }
}

/** Часы, синхронные с конкретным хостом Bybit: публичный `GET /v5/market/time` (без подписи). */
export function createBybitServerClock(host: string, options: ServerClockOptions = {}): ServerClock {
  return new ServerClock(async () => {
    const res = await fetch(`${host}/v5/market/time`, { signal: AbortSignal.timeout(5000) })
    const body = (await res.json()) as { retCode: number; result?: { timeNano?: string; timeSecond?: string } }
    if (body.retCode !== 0) throw new Error(`Bybit /v5/market/time: retCode=${body.retCode}`)
    const nano = body.result?.timeNano
    if (nano) return Number(nano.slice(0, 13))
    const second = body.result?.timeSecond
    if (second) return Number(second) * 1000
    throw new Error('Bybit /v5/market/time: пустой ответ')
  }, options)
}
