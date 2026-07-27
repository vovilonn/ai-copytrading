// Реконсиляция состояния при старте (Ф3, задача 4; research bybit-execution.md §14 «Реконсиляция
// #TR-x ↔ биржевые позиции», design plan docs/superpowers/plans/2026-07-11-phase-3-live-testnet.md).
// Биржа — единственный источник истины: локальный журнал (trades/positions) чинится ПО НЕЙ, а не
// наоборот. Процедура из §14: (1) position/list — что реально открыто; (2) order/realtime — что
// висит; (3) слить с журналом по orderLinkId/symbol; (4) расхождение → биржа истина, журнал
// чинится; (5) createdTime защищает от «чужой» позиции.
//
// DRY-RUN vs LIVE (критично для этой задачи — в dev-БД одновременно живут ~76 dry-run-сделок Ф1
// и (пока) 0 live-сделок): в схеме НЕТ отдельного флага exec_mode на trades/positions (enum
// exec_mode создан миграцией 001, но ни одна таблица его не использует), и symbol_ownership тоже
// не различает режим. Реальный, уже существующий сигнал — ПРЕФИКС `orders.order_link_id`
// (execution/order-link-id.ts::MODE_PREFIX): 'D' — DryRunAdapter, 'K' — BybitAdapter. Сделка
// считается LIVE для целей ЭТОЙ реконсиляции ⟺ у неё есть хотя бы один ордер с orderLinkId,
// начинающимся на 'K'. Реконсиляция LIVE смотрит ТОЛЬКО на такие сделки — dry-run сделки (только
// 'D'-ордера) целиком вне её поля зрения, не закрываются и не трогаются, сколько бы их ни было.
// Раздельного столбца/таблицы не заводили сознательно — задача явно запрещает трогать
// apps/api (миграции) и предлагает минимальное решение поверх уже существующих данных.
//
// Атрибуция неизвестной позиции биржи (§14: "не угадывать канал вслепую"): trades.channel_id
// NOT NULL — создать строку trades для позиции без атрибуции значило бы угадать канал. Вместо
// этого пишем в `audit_log` (миграция 001, уже существует, не типизирован в Kysely DB — доступ
// через sql`` тем же приёмом, что и остальные "сырые" таблицы схемы) и считаем во `flagged`.

import { Decimal } from 'decimal.js'
import { sql, type Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Side, TradeStatus } from 'shared/domain.js'
import { acquireSymbol, closeTrade } from '../state/trades.js'
import { emitPositionUpsert } from '../pipeline.js'
import { recalcTradesMoney } from '../state/recalc-trade.js'
import { attributeExecution } from './sync/attribute.js'
import { backfillExecutions } from './sync/backfill-executions.js'
import { backfillClosedPnl } from './sync/backfill-closed-pnl.js'
import { syncOrderStatuses } from './sync/sync-orders.js'
import { BOOTSTRAP_LOOKBACK_MS, OVERLAP_MS, cursorKey, readCursor, writeCursor } from './sync/cursor.js'
import type { BybitRestClient, Order, Position } from './rest-client.js'

/** Узкий срез BybitRestClient — тот же приём, что и BybitAdapterRestClient/BybitPrivateWsRestClient.
 *  Кроме снапшота (position/list + order/realtime) и отмены осиротевших остатков, реконсиляция теперь
 *  ДОЧИТЫВАЕТ ИСТОРИЮ: execution/list (что реально исполнилось, включая ручные действия оператора),
 *  position/closed-pnl (реальный PnL закрытий — execution/list его не отдаёт) и order/history
 *  (терминальные статусы ордеров, которых WS мог не донести). */
export type ReconcileRestClient = Pick<
  BybitRestClient,
  'getPositions' | 'getOpenOrders' | 'cancelOrder' | 'getExecutions' | 'getOrderHistory' | 'getClosedPnl'
>

/**
 * Скоуп сверки: КАКИЕ каналы обслуживает аккаунт, чьим клиентом мы сейчас смотрим на биржу.
 *
 * Без него сверка аккаунта A увидела бы «сделки канала B, у которых на бирже нет позиции» — и
 * закрыла бы их: позиции канала B живут на ДРУГОМ аккаунте и в этом снапшоте отсутствуют по
 * определению. Не задан — прежнее глобальное поведение (один аккаунт на всё).
 */
export interface ReconcileScope {
  channelIds?: readonly number[]
  /** Курсоры догона истории у каждого аккаунта свои (cursor.ts::cursorKey). */
  accountFingerprint?: string
}

export interface ReconcileResult {
  /** Позиция на бирже атрибутирована по orderLinkId к сделке журнала, которая не была 'open' —
   *  восстановлена (статус зафиксирован в 'open', поля синхронизированы). */
  opened: number
  /** Сделка была 'open'/'partially_closed' в журнале, но позиции на бирже нет — закрыта по бирже. */
  closed: number
  /** Позиция на бирже без однозначной атрибуции (нет кандидата, кандидатов >1, или единственный
   *  кандидат отбракован createdTime-защитой) — залогирована в audit_log, журнал НЕ угадывает канал. */
  flagged: number
  /**
   * Minor M1 адверсариального ревью (p3-core-fix-report.md): reduceOnly-остатки биржи (TP/SL/
   * close) по символам БЕЗ открытой позиции — "осиротевшие" (ручное закрытие мимо нашего WS,
   * пропущенный cancelAll-пуш applyPositionPush, гонка реконнекта и т.п.). Отменены по одному
   * (НЕ cancelAll — не трогаем legitimate entry/add лимитки того же символа, ожидающие первого
   * филла). Эта же функция дёргается и на старте, и периодически (main.ts, RECONCILE_INTERVAL_MS)
   * — очистка происходит обоими путями, отдельного механизма не требуется.
   */
  orphansCancelled: number
  /**
   * Important I1 финального ревью Ф3: `executions`, вставленные приватным WS ДО коммита строки
   * `orders` тем же order_link_id (гонка транзакций — market-ордер уходит на биржу изнутри ещё
   * не закоммиченной транзакции pipeline.ts, а execution с отдельного WS-соединения в READ
   * COMMITTED её не видит) — "осиротевшие" (order_id/trade_id/leg_id=null). К моменту
   * reconcileOnStart строка orders уже точно закоммичена — переатрибутированы по order_link_id,
   * realized_pnl затронутых сделок пересчитан той же формулой, что applyExecutionPush
   * (recalcTradeRealizedPnl). Самоисцеление в пределах RECONCILE_INTERVAL_MS (10 мин, та же
   * периодичность, что и orphansCancelled выше).
   */
  reattributedExecutions: number
  /** Фантомные строки зеркала (ненулевой size у сделки, которой на бирже нет) — занулены (шаг Б2). */
  phantomsZeroed: number
  /** Сверка не выполнена (сбой Bybit/сети) — состояние журнала может расходиться с биржей.
   *  Проставляется вызывающим (main.ts), а не самой reconcileOnStart: та либо отработала целиком,
   *  либо бросила. Нужен, чтобы старт движка не падал в crash-loop из-за 5xx биржи. */
  degraded?: boolean
}

// execution/order-link-id.ts::MODE_PREFIX.live — не экспортирован оттуда (сознательно не трогаем
// чужой файл), поэтому продублирован здесь одной константой с явной ссылкой на источник.
const LIVE_ORDER_LINK_PREFIX = 'K'

// Нетерминальные статусы journal — потенциально ещё актуальные на бирже (design spec: pending —
// сделка создана, но по факту первого филла ещё не подтверждена; в текущем pipeline.ts эта строка
// практически недостижима вне рестарта посреди транзакции, но фильтр включает её на будущее).
const LIVE_JOURNAL_STATUSES: readonly TradeStatus[] = ['pending', 'open', 'partially_closed']
const OPEN_STATUSES: ReadonlySet<TradeStatus> = new Set(['open', 'partially_closed'])

/**
 * Допуск гейта «чужой позиции» (шаг А) и recency-гейта свежих сделок F2/F8 (шаги Б/Г) — один на оба,
 * они симметричны.
 *
 * ⚠️ НИКОГДА не сравнивайте с opened_at поле `position.createdTime`. В Bybit V5 это «время, когда
 * позиция по ЭТОМУ СИМВОЛУ была создана ВПЕРВЫЕ»: биржа переиспользует слот позиции по символу и НЕ
 * сбрасывает createdTime при закрытии/повторном открытии. Проверено живьём: у только что открытой
 * SOLUSDT createdTime=11.07 13:13 (первая в истории аккаунта позиция по символу), а реальный филл
 * (updatedTime) — 13.07 08:39. Разрыв createdTime↔opened_at растёт БЕЗ ГРАНИЦ с возрастом символа на
 * аккаунте, поэтому никакой конечный допуск его не покрывает — каждый ПОВТОРНЫЙ вход по уже
 * торговавшемуся символу детерминированно уходил в ambiguous и не попадал в `positions`.
 *
 * Корректный носитель сигнала — `updatedTime` («последнее касание позиции»): он бампается филлом
 * входа, поэтому для НАШЕЙ позиции всегда ≈ opened_at (филл на бирже физически предшествует коммиту
 * нашей строки — на SOLUSDT разрыв был 245 мс). Здесь разрыв ОГРАНИЧЕН СВЕРХУ длительностью
 * транзакции pipeline (~1с), и 60с покрывают его с запасом.
 */
const POSITION_STALENESS_TOLERANCE_MS = 60_000

interface LocalTrade {
  id: string
  symbol: string
  status: TradeStatus
  channel_id: number
  human_ref: string
  opened_at: Date | null
}

export interface HistorySyncResult {
  executionsInserted: number
  manualActions: number
  pnlPatched: number
  tradesRecalculated: number
  ordersSynced: number
  /** Даунтайм оказался длиннее ретенции биржи (2 года) — часть истории невосстановима. */
  truncated: boolean
}

/**
 * Догон истории с биржи по водяному знаку: исполнения → реальный PnL → пересчёт денег → статусы
 * ордеров. Именно этот блок закрывает требование «полная синхронизация, даже если сервис лежал
 * день, и подтягиваются ручные действия с биржи».
 */
async function syncHistory(db: Kysely<DB>, rest: ReconcileRestClient, scope: ReconcileScope = {}): Promise<HistorySyncResult> {
  const nowMs = Date.now()
  const oldestLiveTradeMs = await findOldestLiveTradeMs(db, scope.channelIds)

  // 1. Исполнения. exec_pnl у REST-строк ещё 0 — его отдаёт только closed-pnl (шаг 2).
  const execs = await backfillExecutions(db, rest, nowMs, oldestLiveTradeMs, scope.accountFingerprint)

  // 2. Реальный PnL закрытий (включая РУЧНЫЕ) → патч exec_pnl REST-строк.
  const pnl = await backfillClosedPnl(db, rest, nowMs, oldestLiveTradeMs, scope.accountFingerprint)

  // 3. Пересчёт денег затронутых сделок — ТОЛЬКО после того, как PnL проставлен.
  const affected = [...new Set([...execs.affectedTradeIds, ...pnl.affectedTradeIds])]
  const tradesRecalculated = affected.length
    ? await db.transaction().execute((trx) => recalcTradesMoney(trx, affected))
    : 0

  // 4. Статусы ордеров: единственный писатель раньше был WS, репара не существовало вовсе.
  const historyFrom = (await readCursor(db, cursorKey('sync:order_history', scope.accountFingerprint))) ?? nowMs - BOOTSTRAP_LOOKBACK_MS
  const orders = await syncOrderStatuses(db, rest, historyFrom - OVERLAP_MS, nowMs)
  await writeCursor(db, cursorKey('sync:order_history', scope.accountFingerprint), nowMs)

  if (execs.inserted > 0 || pnl.patched > 0 || orders.updated > 0) {
    console.log(
      `[reconcile] догон истории: исполнений +${execs.inserted} (ручных ${execs.manual}, ` +
        `непривязанных ${execs.unattributed}), PnL проставлен ${pnl.patched}, ` +
        `сделок пересчитано ${tradesRecalculated}, статусов ордеров ${orders.updated}`,
    )
  }

  return {
    executionsInserted: execs.inserted,
    manualActions: execs.manual,
    pnlPatched: pnl.patched,
    tradesRecalculated,
    ordersSynced: orders.updated,
    truncated: execs.truncated || pnl.truncated,
  }
}

/** Самая старая ЖИВАЯ сделка журнала — чтобы при первом запуске не обрезать её филлы окном в 7 дней. */
async function findOldestLiveTradeMs(db: Kysely<DB>, channelIds?: readonly number[]): Promise<number | null> {
  let query = db
    .selectFrom('trades')
    .select('opened_at')
    .where('status', 'in', LIVE_JOURNAL_STATUSES)
    .where('opened_at', 'is not', null)
    .orderBy('opened_at', 'asc')
    .limit(1)
  // Глубина догона считается по САМОЙ СТАРОЙ живой сделке ЭТОГО аккаунта: чужая старая сделка
  // заставила бы читать историю за лишние недели на каждом проходе.
  if (channelIds) query = query.where('channel_id', 'in', channelIds.length > 0 ? [...channelIds] : [-1])
  const row = await query.executeTakeFirst()
  return row?.opened_at ? row.opened_at.getTime() : null
}

/**
 * Процедура старта (§14, дословно шаги 1-4; шаг 5 — переподписка WS-водяного знака — забота
 * задачи 3/main.ts, не этой функции): читает `position/list`+`order/realtime`, сливает с локальным
 * журналом LIVE-сделок (см. комментарий вверху файла про 'K'-префикс) и чинит журнал по бирже.
 * Одна транзакция БД — либо весь эффект коммитится, либо ничего (крэш посреди реконсиляции не
 * оставляет "половину" исправлений). Сетевые READ-вызовы — ДО транзакции (не держат её открытой).
 */
export async function reconcileOnStart(
  db: Kysely<DB>,
  rest: ReconcileRestClient,
  scope: ReconcileScope = {},
): Promise<ReconcileResult> {
  // ==========================================================================================
  // ДОГОН ИСТОРИИ (шаги 1-4) — ДО снапшота позиций. Порядок здесь принципиален и менять его нельзя.
  //
  // WS не переигрывает пропущенное: всё, что случилось на бирже, пока движок лежал (или пока WS был
  // в обрыве), не попадёт в журнал никогда — если не дочитать это REST-ом. Сюда же попадают РУЧНЫЕ
  // действия оператора (закрытие, частичная фиксация), у которых нет наших ордеров.
  //
  // Почему деньги считаются ДО закрытия сделок (шаг Б ниже): closeTrade выводит is_win из ТЕКУЩЕГО
  // realized_pnl. Закрыть сделку раньше, чем дочитаны её филлы, — значит навсегда записать is_win,
  // посчитанный по нулевому PnL, и получить лживый Win Rate канала.
  // ==========================================================================================
  const historyResult = await syncHistory(db, rest, scope).catch((err) => {
    // Догон истории не должен ронять сверку позиций: она чинит более важное (что реально открыто).
    console.error('[reconcile] догон истории не удался — продолжаю со сверкой позиций:', err)
    return null
  })

  // F2/F8 (адверсариальное ревью): момент снапшота getPositions (T0). getPositions() читается ДО
  // транзакции; localLiveTrades — внутри неё (READ COMMITTED), поэтому reconcile может увидеть
  // только что открытую параллельным пайплайном сделку (opened_at>T0), которой ещё нет в снапшоте.
  // Фиксируем T0, чтобы recency-гейт (tradeOpenedAfterSnapshot) отличил такую свежую сделку от
  // реально устаревшей и не закрыл/не разоружил её по устаревшему снапшоту.
  const snapshotAtMs = Date.now()
  const allPositions = await rest.getPositions()
  const positions = allPositions.filter((p) => new Decimal(p.size).gt(0))
  const openOrders = await rest.getOpenOrders()
  // M1: нужен и внутри транзакции (шаг Б), и ПОСЛЕ её коммита (шаг В, orphan-очистка ниже) —
  // вынесен наружу, а не в двух местах отдельно (DRY).
  const positionSymbols = new Set(positions.map((p) => p.symbol))
  // F8: символы LIVE-сделок, открытых в момент снапшота или позже — их reduceOnly-остатки (шаг Г,
  // ПОСЛЕ транзакции) НЕ отменяем по устаревшему/лагающему снапшоту (симметрично F2 шага Б).
  // Наполняется внутри транзакции (из localLiveTrades.opened_at), читается снаружи в шаге Г.
  const freshlyOpenedSymbols = new Set<string>()

  let opened = 0
  let closed = 0
  let flagged = 0
  let reattributedExecutions = 0
  let phantomsZeroed = 0

  await db.transaction().execute(async (trx) => {
    let localLiveTradesQuery = trx
      .selectFrom('trades')
      .select(['id', 'symbol', 'status', 'channel_id', 'human_ref', 'opened_at'])
      .where('status', 'in', LIVE_JOURNAL_STATUSES)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('orders')
            .select('orders.id')
            .whereRef('orders.trade_id', '=', 'trades.id')
            .where('orders.order_link_id', 'like', `${LIVE_ORDER_LINK_PREFIX}%`),
        ),
      )
    if (scope.channelIds) {
      localLiveTradesQuery = localLiveTradesQuery.where('channel_id', 'in', scope.channelIds.length > 0 ? [...scope.channelIds] : [-1])
    }
    const localLiveTrades = await localLiveTradesQuery.execute()

    const bySymbol = new Map<string, LocalTrade[]>()
    for (const t of localLiveTrades) {
      const arr = bySymbol.get(t.symbol)
      if (arr) arr.push(t)
      else bySymbol.set(t.symbol, [t])
      // F8: собираем «свежие» символы здесь же (один проход), используются в шаге Г вне транзакции.
      if (tradeOpenedAfterSnapshot(t.opened_at, snapshotAtMs)) freshlyOpenedSymbols.add(t.symbol)
    }

    // --- Шаг А: что реально открыто на бирже -> сверка/атрибуция/needs_review-флаг. ---
    for (const pos of positions) {
      const allCandidates = bySymbol.get(pos.symbol) ?? []
      const openCandidates = allCandidates.filter((t) => OPEN_STATUSES.has(t.status))

      if (openCandidates.length === 1) {
        const trade = openCandidates[0]!
        // Владение доказывается ДВУМЯ независимыми способами, достаточно любого:
        //  1) ДЕТЕРМИНИРОВАННО — на символе висит НАШ ('K'-префикс) ордер, привязанный именно к этой
        //     сделке. orderLinkId генерируем мы сами (order-link-id.ts), это не догадка по времени.
        //     Тот же механизм, что и attributeBySymbolOrders ниже; раньше он был недостижим при
        //     единственном кандидате — и это была половина бага «позиция не видна в UI».
        //  2) ЭВРИСТИЧЕСКИ — позицию трогали на бирже не раньше нашего входа. Нужен как фолбэк,
        //     когда наших ордеров на символе уже не висит: TP исполнились, а SL — trading-stop, для
        //     которого Bybit вообще не отдаёт orderLinkId.
        const confirmed = await attributeBySymbolOrders(trx, pos.symbol, openOrders)
        const ownedByOurOrders = confirmed !== null && confirmed.tradeId === trade.id
        if (ownedByOurOrders || !positionUntouchedBeforeLocalOpen(pos, trade.opened_at)) {
          await syncMatchedTrade(trx, trade.channel_id, trade.id, pos)
          continue
        }
      }

      if (openCandidates.length >= 1) {
        // >1 кандидат на символ ИЛИ единственный не подтверждён НИ нашим orderLinkId, НИ свежестью
        // позиции ⇒ пред-существующая/«чужая» позиция. Не угадываем владельца, не перетираем журнал.
        await logAmbiguousPosition(
          trx,
          pos,
          openCandidates.map((t) => t.human_ref),
        )
        flagged++
        continue
      }

      // Нет открытого LIVE-кандидата журнала на этот символ — попытка атрибуции по orderLinkId
      // висящих ордеров биржи (§14: "связь через orderLinkId").
      const attribution = await attributeBySymbolOrders(trx, pos.symbol, openOrders)
      if (attribution) {
        const reopenedOk = await reopenTrade(trx, attribution, pos)
        if (reopenedOk) {
          opened++
        } else {
          // Атрибуция нашла сделку, но символ занят ДРУГОЙ активной записью владения (напр.
          // dry-run сделка того же канала держит symbol_ownership) — не отбираем силой.
          await logAmbiguousPosition(trx, pos, [attribution.humanRef])
          flagged++
        }
        continue
      }

      // Совсем неизвестная позиция — не создаём trades-строку вслепую (channel_id NOT NULL,
      // угадать канал нельзя), логируем в audit_log для ручного разбора.
      await logUnknownPosition(trx, pos)
      flagged++
    }

    // --- Шаг Б: LIVE-сделки 'open'/'partially_closed' без позиции на бирже -> закрыть. ---
    //
    // ⚠️ ОТЛОЖЕННЫЙ ВХОД — НЕ «сделка без позиции». Живой инцидент прода 27.07.2026: канал дал
    // лимитку «1910 limit long ETH», движок выставил ордер, а через 10 минут этот шаг закрыл сделку
    // (позиции-то на бирже ещё нет — лимитка не исполнилась) и снял владение символом. Сама лимитка
    // при этом осталась висеть на бирже с TTL 7 суток: исполнись она — на счёте открылась бы
    // позиция, которой в журнале соответствует ЗАКРЫТАЯ сделка, то есть бот не поставил бы ей стоп
    // и не реагировал бы на команды канала. Поэтому сделку с ЖИВЫМ ордером входа на бирже не
    // трогаем — её судьбу решает либо исполнение, либо TTL-свип, либо явная отмена каналом.
    const tradeIdsWithLiveEntry = await tradesWithLiveEntryOrders(trx, openOrders)
    for (const t of localLiveTrades) {
      if (!OPEN_STATUSES.has(t.status)) continue
      if (positionSymbols.has(t.symbol)) continue // уже обработана в шаге А (синк или ambiguous)
      if (tradeIdsWithLiveEntry.has(t.id)) continue
      // F2: свежая сделка (opened_at в момент снапшота T0 или позже, с допуском на лаг биржи/
      // рассинхрон часов) могла ещё не попасть в снапшот getPositions — НЕ закрываем её без
      // close-ордера по устаревшему снапшоту (иначе осиротим только что открытую живую позицию).
      if (tradeOpenedAfterSnapshot(t.opened_at, snapshotAtMs)) continue
      await closeTrade(trx, { tradeId: t.id, status: 'closed' })
      await zeroPositionRow(trx, t.channel_id, t.symbol)
      closed++
    }

    // --- Шаг Б2: ФАНТОМНЫЕ строки зеркала (найдено живым e2e) ---
    //
    // Шаг Б выше чинит только сделки, ОТКРЫТЫЕ в журнале. Но зеркало может остаться ненулевым и
    // у уже ЗАКРЫТОЙ сделки: финальный пуш `position size=0` не дошёл (потерянный/переупорядоченный
    // фрейм WS), а закрытие в журнале выполнил сам пайплайн. Такая строка не лечилась НИКЕМ —
    // оператор видел в UI позицию, которой на бирже нет, а handleDelta (ищет сделку по
    // `positions.size <> 0`) мог начать ею «управлять».
    //
    // Условия намеренно консервативные: (1) на бирже такой позиции сейчас нет; (2) строка зеркала
    // не свежее снапшота — иначе мы затрём то, что WS узнал ПОЗЖЕ нашего похода на биржу;
    // (3) сделка строки — наша ЖИВАЯ (есть 'K'-ордер), чтобы не трогать зеркала dry-run-сделок.
    const phantoms = await sql<{ channel_id: number; symbol: string }>`
      UPDATE positions p SET size = 0, updated_at = now()
      WHERE p.size <> 0
        AND NOT (p.symbol = ANY(${[...positionSymbols]}::text[]))
        AND p.updated_at < ${new Date(snapshotAtMs)}
        AND EXISTS (
          SELECT 1 FROM orders o
           WHERE o.trade_id = p.trade_id
             AND o.order_link_id LIKE ${`${LIVE_ORDER_LINK_PREFIX}%`}
        )
        -- Скоуп аккаунта: фантом чужого канала лечит сверка ЕГО аккаунта, у которой есть настоящий
        -- снапшот биржи. Отсюда мы про его позиции не знаем ничего.
        AND (${scope.channelIds === undefined} OR p.channel_id = ANY(${[...(scope.channelIds ?? [])]}::bigint[]))
      RETURNING p.channel_id, p.symbol
    `.execute(trx)
    for (const row of phantoms.rows) {
      await emitPositionUpsert(trx, row.channel_id, row.symbol)
      phantomsZeroed++
    }

    // --- Шаг В (I1 финального ревью Ф3): переатрибуция осиротевших execution. ---
    reattributedExecutions = await reattributeOrphanedExecutions(trx)
  })

  // --- Шаг Г (M1, Minor адверсариального ревью): осиротевшие reduceOnly-остатки — ПОСЛЕ коммита
  // транзакции, тот же приём "сеть не держит транзакцию БД", что и cancelAll в
  // private-ws.ts::applyPositionPush. Только reduceOnly (TP/SL/close) — entry/add лимитки того
  // же "бессимвольного" положения НЕ трогаем, они законно ждут первого филла.
  // F8 (адверсариальное ревью): дополнительно НЕ трогаем reduceOnly-остаток символа свежей
  // LIVE-сделки (freshlyOpenedSymbols) — позиция могла быть открыта в момент снапшота или позже,
  // её защитный TP/SL легитимен, снапшот getPositions(T0) просто ещё не застал позицию (лаг биржи).
  //
  // И только НАШИ ордера ('K'-префикс, order-link-id.ts). Раньше фильтра по префиксу не было —
  // реконсиляция снимала бы reduce-only ордера, выставленные ОПЕРАТОРОМ вручную с биржи (у них
  // чужой orderLinkId либо пустой, как у trading-stop). Чужие ордера — не наша зона ответственности:
  // мы не имеем права отменять то, что не ставили.
  // Скоуп аккаунта тут не нужен отдельным фильтром: openOrders приходят с ЭТОГО аккаунта, а
  // K-префикс уже отсекает чужие (ручные) ордера. Каналы другого аккаунта своих ордеров в этом
  // снапшоте иметь не могут по определению.
  const orphans = openOrders.filter(
    (o) =>
      o.reduceOnly &&
      o.orderLinkId.startsWith(LIVE_ORDER_LINK_PREFIX) &&
      !positionSymbols.has(o.symbol) &&
      !freshlyOpenedSymbols.has(o.symbol),
  )
  let orphansCancelled = 0
  for (const order of orphans) {
    try {
      await rest.cancelOrder({ symbol: order.symbol, orderLinkId: order.orderLinkId })
      orphansCancelled++
    } catch (err) {
      console.error(
        `[reconcile] отмена осиротевшего reduceOnly-ордера symbol=${order.symbol} orderLinkId=${order.orderLinkId} не удалась:`,
        err,
      )
    }
  }

  return { opened, closed, flagged, orphansCancelled, reattributedExecutions, phantomsZeroed }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPositionSide(raw: string): Side | null {
  if (raw === 'Buy') return 'long'
  if (raw === 'Sell') return 'short'
  return null // 'None' — плоская позиция-стаб (сюда не попадаем: positions уже отфильтрован size>0)
}

/**
 * Bybit отдаёт ПУСТУЮ СТРОКУ вместо числа в необязательных полях position/list — проверено живьём
 * на demo: `liqPrice=""` у реально открытой позиции (cross-маржа без риска ликвидации), `markPrice=""`
 * на «холодном» символе (последнее уже задокументировано в rest-client.ts::Ticker). В Postgres
 * `''::numeric` — ОШИБКА («invalid input syntax for type numeric»), которая рвёт ВСЮ транзакцию
 * реконсиляции; на старте (main.ts::reconcileOnStart вызывается без catch, в отличие от периодического
 * прохода) это положило бы движок в boot-loop. Колонки positions.* nullable (миграция 001) — пустое
 * значение биржи означает «неизвестно», то есть NULL. Тот же приём, что private-ws.ts::asNonEmptyString.
 */
function numOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value
}

/**
 * Гейт «чужой» позиции (§14) — ЭВРИСТИЧЕСКИЙ фолбэк к детерминированной проверке по orderLinkId
 * (шаг А). Позицию не трогали на бирже (updatedTime бампается филлом/добором/частичным закрытием/
 * правкой TP-SL) ЗАДОЛГО ДО нашего локального opened_at ⇒ наш вход её не создавал: это ручная или
 * пред-существующая «чужая» позиция — не присваиваем её своей сделке и не перетираем ею журнал.
 *
 * Смысл исходной защиты сохранён дословно, изменён только НОСИТЕЛЬ сигнала: createdTime выразить
 * его не способен (см. POSITION_STALENESS_TOLERANCE_MS).
 */
function positionUntouchedBeforeLocalOpen(pos: Position, tradeOpenedAt: Date | null): boolean {
  if (tradeOpenedAt === null) return false // opened_at ещё не проставлен — гейт неприменим
  const posUpdatedMs = Number(pos.updatedTime)
  if (!Number.isFinite(posUpdatedMs) || posUpdatedMs === 0) return false // поле пустое/битое — не бракуем вслепую
  return posUpdatedMs < tradeOpenedAt.getTime() - POSITION_STALENESS_TOLERANCE_MS
}

/**
 * F2/F8 (адверсариальное ревью): recency-гейт, симметричный гейту «чужой позиции» шага А
 * (positionUntouchedBeforeLocalOpen, ТОТ ЖЕ POSITION_STALENESS_TOLERANCE_MS). Сделка, открытая в
 * момент снапшота getPositions (snapshotAtMs) или позже — с допуском на лаг биржи/рассинхрон часов —
 * могла ещё не попасть в снапшот: её НЕЛЬЗЯ закрывать (шаг Б) или снимать её защитный reduceOnly
 * (шаг Г) по устаревшему снапшоту. opened_at=null — гейт неприменим.
 */
function tradeOpenedAfterSnapshot(tradeOpenedAt: Date | null, snapshotAtMs: number): boolean {
  if (tradeOpenedAt === null) return false
  return tradeOpenedAt.getTime() >= snapshotAtMs - POSITION_STALENESS_TOLERANCE_MS
}

/** Совпадение по символу (единственный открытый LIVE-кандидат, прошедший createdTime-защиту):
 *  синхронизирует size/avg_entry/leverage и зеркало positions из биржи, статус НЕ меняет. */
async function syncMatchedTrade(trx: Kysely<DB>, channelId: number, tradeId: string, pos: Position): Promise<void> {
  await trx
    .updateTable('trades')
    .set({ avg_entry: pos.avgPrice, size: pos.size, leverage: pos.leverage, updated_at: new Date() })
    .where('id', '=', tradeId)
    .execute()
  await upsertPositionFromExchange(trx, channelId, tradeId, pos)
  await emitPositionUpsert(trx, channelId, pos.symbol)
}

interface Attribution {
  tradeId: string
  channelId: number
  humanRef: string
}

/**
 * Атрибуция позиции без открытого LIVE-кандидата по orderLinkId висящих ордеров биржи (§14):
 * ищем среди `order/realtime` этого символа ордера с LIVE-префиксом, сопоставляем их orderLinkId
 * с локальной таблицей `orders` (order_link_id UNIQUE, есть trade_id) — эта связь ЕДИНСТВЕННАЯ
 * сквозная через рестарт (у самой позиции orderLinkId нет, это агрегат). Более одного РАЗНОГО
 * trade_id среди найденных ордеров — неоднозначность, не угадываем (возвращаем null).
 */
/**
 * Сделки, у которых на бирже ЖИВ ордер входа (entry/add). Такая сделка ещё не «потеряла позицию» —
 * она её просто не открыла: лимитка ждёт своей цены. Закрывать её нельзя (см. шаг Б).
 *
 * reduceOnly-ордера (tp/sl/close) сюда НЕ считаются: они защищают уже открытую позицию, и их
 * наличие при отсутствии позиции — как раз признак осиротевшего остатка (его чинит шаг В).
 */
async function tradesWithLiveEntryOrders(trx: Kysely<DB>, openOrders: readonly Order[]): Promise<Set<string>> {
  const liveLinkIds = openOrders
    .filter((o) => o.orderLinkId.startsWith(LIVE_ORDER_LINK_PREFIX) && !o.reduceOnly)
    .map((o) => o.orderLinkId)
  if (liveLinkIds.length === 0) return new Set()

  const rows = await trx
    .selectFrom('orders')
    .select('trade_id')
    .where('order_link_id', 'in', liveLinkIds)
    .where('purpose', 'in', ['entry', 'add'])
    .where('trade_id', 'is not', null)
    .execute()
  return new Set(rows.map((r) => r.trade_id as string))
}

async function attributeBySymbolOrders(trx: Kysely<DB>, symbol: string, openOrders: readonly Order[]): Promise<Attribution | null> {
  const candidateLinkIds = openOrders.filter((o) => o.symbol === symbol && o.orderLinkId.startsWith(LIVE_ORDER_LINK_PREFIX)).map((o) => o.orderLinkId)
  if (candidateLinkIds.length === 0) return null

  const rows = await trx
    .selectFrom('orders')
    .innerJoin('trades', 'trades.id', 'orders.trade_id')
    .select(['trades.id as tradeId', 'trades.channel_id as channelId', 'trades.human_ref as humanRef'])
    .where('orders.order_link_id', 'in', candidateLinkIds)
    .execute()

  const first = rows[0]
  if (!first) return null
  const distinctTradeIds = new Set(rows.map((r) => r.tradeId))
  if (distinctTradeIds.size !== 1) return null // разные ордера символа ссылаются на разные сделки — не угадываем

  return first
}

/** Атрибутированная сделка не была 'open' (была 'pending'/'closed'/'cancelled'/'skipped') —
 *  биржа показывает реальную позицию, значит журнал отстал: восстанавливаем статус 'open' и
 *  владение символом. @returns false, если символ занят ДРУГОЙ активной записью (не отбираем силой). */
async function reopenTrade(trx: Kysely<DB>, attribution: Attribution, pos: Position): Promise<boolean> {
  const acquired = await acquireSymbol(trx, { channelId: attribution.channelId, symbol: pos.symbol, tradeId: attribution.tradeId })
  if (!acquired) return false

  await trx
    .updateTable('trades')
    .set({
      status: 'open',
      avg_entry: pos.avgPrice,
      size: pos.size,
      leverage: pos.leverage,
      closed_at: null,
      updated_at: new Date(),
    })
    .where('id', '=', attribution.tradeId)
    .execute()

  await upsertPositionFromExchange(trx, attribution.channelId, attribution.tradeId, pos)
  await emitPositionUpsert(trx, attribution.channelId, pos.symbol)
  return true
}

/** UPSERT зеркала `positions` из живых данных биржи (тот же приём/поля, что и
 *  bybit/private-ws.ts::applyPositionPush, но полный снапшот REST — не мерж дельт поверх старого). */
async function upsertPositionFromExchange(trx: Kysely<DB>, channelId: number, tradeId: string, pos: Position): Promise<void> {
  const side = mapPositionSide(pos.side)
  await sql`
    INSERT INTO positions (
      channel_id, symbol, trade_id, side, size, avg_price, mark_price, liq_price,
      leverage, unrealised_pnl, take_profit, stop_loss, position_status, bybit_seq, updated_at
    ) VALUES (
      ${channelId}, ${pos.symbol}, ${tradeId}::uuid, ${side}::side_t, ${numOrNull(pos.size) ?? '0'}::numeric,
      ${numOrNull(pos.avgPrice)}::numeric, ${numOrNull(pos.markPrice)}::numeric, ${numOrNull(pos.liqPrice)}::numeric,
      ${numOrNull(pos.leverage)}::numeric, ${numOrNull(pos.unrealisedPnl)}::numeric,
      ${numOrNull(pos.takeProfit)}::numeric, ${numOrNull(pos.stopLoss)}::numeric,
      ${pos.positionStatus}, ${pos.seq}, now()
    )
    ON CONFLICT (channel_id, symbol) DO UPDATE SET
      trade_id = EXCLUDED.trade_id,
      side = EXCLUDED.side,
      size = EXCLUDED.size,
      avg_price = EXCLUDED.avg_price,
      -- COALESCE (тот же приём, что private-ws.ts): пустой markPrice на «холодном» символе не должен
      -- затирать цену, уже известную из тикер-фида.
      mark_price = COALESCE(EXCLUDED.mark_price, positions.mark_price),
      liq_price = EXCLUDED.liq_price,
      leverage = EXCLUDED.leverage,
      unrealised_pnl = EXCLUDED.unrealised_pnl,
      -- SL/TP биржи (protective-стопы позиции): без них карточка показывала бы «—» при реально
      -- выставленном на бирже стопе — оператор решил бы, что позиция не защищена.
      take_profit = EXCLUDED.take_profit,
      stop_loss = EXCLUDED.stop_loss,
      position_status = EXCLUDED.position_status,
      bybit_seq = EXCLUDED.bybit_seq,
      updated_at = now()
    -- Водяной знак seq: REST-снапшот снимается ДО транзакции, а пока она идёт, живой WS мог прислать
    -- более СВЕЖЕЕ состояние позиции. Без этого гейта устаревший снапшот откатывал бы позицию назад
    -- (например, воскрешал уже закрытую). WS-путь такой гейт имеет (private-ws.ts), REST — не имел.
    -- seq строго возрастает у Bybit в рамках символа; NULL слева — строка от dry-run/старых данных,
    -- её перезаписываем безусловно.
    WHERE positions.bybit_seq IS NULL OR EXCLUDED.bybit_seq >= positions.bybit_seq
  `.execute(trx)
}

/** Позиция закрыта по бирже (шаг Б) — зануляем зеркало `positions`, если строка вообще была. */
async function zeroPositionRow(trx: Kysely<DB>, channelId: number, symbol: string): Promise<void> {
  const updated = await trx
    .updateTable('positions')
    .set({ size: '0', updated_at: new Date() })
    .where('channel_id', '=', channelId)
    .where('symbol', '=', symbol)
    .returning('symbol')
    .executeTakeFirst()
  if (updated) await emitPositionUpsert(trx, channelId, symbol)
}

/**
 * Шаг В (I1 финального ревью Ф3): переатрибуция "осиротевших" execution — вставленных приватным
 * WS (private-ws.ts::applyExecutionPush) раньше, чем закоммитилась строка `orders` того же
 * order_link_id (гонка: market-ордер уходит на биржу ВНУТРИ ещё не закоммиченной транзакции
 * pipeline.ts::placeEntry/closePosition, исполнение — миллисекунды, а WS-обработчик на отдельном
 * соединении в READ COMMITTED не видит незакоммиченную строку `orders` и вставляет execution с
 * order_id/trade_id/leg_id=null). К моменту reconcileOnStart (10 мин интервал) строка `orders`
 * уже точно закоммичена — привязываем по order_link_id (UPDATE ... FROM, тот же паттерн, что и
 * остальные "сырые" JOIN-запросы этого модуля) и пересчитываем `trades.realized_pnl` каждой
 * затронутой сделки той же формулой, что applyExecutionPush (recalcTradeRealizedPnl — не
 * дублируем). Идемпотентно: `WHERE executions.order_id IS NULL` — уже привязанные строки
 * (order_id заполнен) повторный запуск не трогает.
 */
async function reattributeOrphanedExecutions(trx: Kysely<DB>): Promise<number> {
  // Раньше здесь был голый JOIN по order_link_id — он чинил ТОЛЬКО гонку «execution пришёл раньше
  // коммита нашей строки orders». Но у РУЧНОГО закрытия оператора orderLinkId чужой, а у филла
  // сработавшего trading-stop он вовсе пустой — такие исполнения оставались сиротами (trade_id=NULL)
  // НАВСЕГДА, и PnL сделки не считался. Живой след: TR-1204 с realized_pnl=0 при реальном убытке.
  // Теперь идём той же атрибуцией, что и весь остальной догон (наш ордер → родитель стопа → ручное).
  const orphans = await trx
    .selectFrom('executions')
    .select(['id', 'order_link_id', 'bybit_order_id', 'symbol', 'exec_ts'])
    .where('trade_id', 'is', null)
    .execute()
  if (orphans.length === 0) return 0

  const affectedTradeIds = new Set<string>()
  let reattributed = 0

  for (const orphan of orphans) {
    const attribution = await attributeExecution(trx, {
      orderLinkId: orphan.order_link_id,
      bybitOrderId: orphan.bybit_order_id,
      symbol: orphan.symbol,
      execTs: orphan.exec_ts,
    })
    if (!attribution.tradeId) continue

    await trx
      .updateTable('executions')
      .set({ order_id: attribution.orderId, trade_id: attribution.tradeId, leg_id: attribution.legId })
      .where('id', '=', orphan.id)
      .execute()

    // Исполнение мимо наших ордеров = ручное вмешательство оператора: канал больше не двигает
    // SL/TP этой сделки (решение заказчика — воля оператора главнее сигнала).
    if (attribution.kind === 'manual') {
      await trx
        .updateTable('trades')
        .set({ manual_override: true, needs_review: true, updated_at: new Date() })
        .where('id', '=', attribution.tradeId)
        .execute()
    }

    affectedTradeIds.add(attribution.tradeId)
    reattributed++
  }

  // Пересчёт денег, а не инкремент: realized_pnl/fees_paid/is_win выводятся из SUM по executions.
  await recalcTradesMoney(trx, [...affectedTradeIds])

  return reattributed
}

/** `audit_log` (миграция 001) существует, но не типизирован в Kysely DB (см. комментарий
 *  database.ts) — доступ через sql`` тем же приёмом, что и остальные "сырые" таблицы схемы. */
async function logUnknownPosition(trx: Kysely<DB>, pos: Position): Promise<void> {
  console.error(
    `[reconcile] неизвестная LIVE-позиция без атрибуции в журнале: symbol=${pos.symbol} side=${pos.side} ` +
      `size=${pos.size} avgPrice=${pos.avgPrice} createdTime=${pos.createdTime} — канал не угадываем вслепую.`,
  )
  const meta = JSON.stringify({ side: pos.side, size: pos.size, avgPrice: pos.avgPrice, createdTime: pos.createdTime })
  await sql`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, meta, message)
    VALUES (
      'reconcileOnStart', 'unknown_position', 'position', ${pos.symbol}, ${meta}::jsonb,
      'неизвестная LIVE-позиция на бирже без атрибуции по orderLinkId — канал не угадывается вслепую, нужен ручной разбор'
    )
  `.execute(trx)
}

async function logAmbiguousPosition(trx: Kysely<DB>, pos: Position, candidateRefs: readonly string[]): Promise<void> {
  console.error(
    `[reconcile] неоднозначная реконсиляция symbol=${pos.symbol}: кандидаты журнала [${candidateRefs.join(', ')}] — не угадываю, нужен ручной разбор.`,
  )
  const meta = JSON.stringify({ side: pos.side, size: pos.size, avgPrice: pos.avgPrice, candidates: candidateRefs })
  await sql`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, meta, message)
    VALUES (
      'reconcileOnStart', 'ambiguous_position', 'position', ${pos.symbol}, ${meta}::jsonb,
      'реконсиляция не смогла однозначно сопоставить позицию биржи ровно одной локальной LIVE-сделке'
    )
  `.execute(trx)
}
