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
import type { BybitRestClient, Order, Position } from './rest-client.js'

/** Узкий срез BybitRestClient — тот же приём, что и BybitAdapterRestClient/BybitPrivateWsRestClient:
 *  реконсиляция читает position/list+order/realtime, и (M1 ниже) умеет отменить ПО ОДНОМУ
 *  осиротевший reduceOnly-остаток — не полный мутирующий набор BybitAdapterRestClient. */
export type ReconcileRestClient = Pick<BybitRestClient, 'getPositions' | 'getOpenOrders' | 'cancelOrder'>

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
}

// execution/order-link-id.ts::MODE_PREFIX.live — не экспортирован оттуда (сознательно не трогаем
// чужой файл), поэтому продублирован здесь одной константой с явной ссылкой на источник.
const LIVE_ORDER_LINK_PREFIX = 'K'

// Нетерминальные статусы journal — потенциально ещё актуальные на бирже (design spec: pending —
// сделка создана, но по факту первого филла ещё не подтверждена; в текущем pipeline.ts эта строка
// практически недостижима вне рестарта посреди транзакции, но фильтр включает её на будущее).
const LIVE_JOURNAL_STATUSES: readonly TradeStatus[] = ['pending', 'open', 'partially_closed']
const OPEN_STATUSES: ReadonlySet<TradeStatus> = new Set(['open', 'partially_closed'])

// createdTime-защита (§14): позиция на бирже старше локального opened_at более чем на этот буфер —
// не наша (нельзя было открыть ПОСЛЕ того, как биржа уже показывает более старую позицию), не
// синкаем вслепую. Буфер покрывает сетевую задержку/рассинхрон часов между вызовом входа и ответом.
const CREATED_TIME_TOLERANCE_MS = 60_000

interface LocalTrade {
  id: string
  symbol: string
  status: TradeStatus
  channel_id: number
  human_ref: string
  opened_at: Date | null
}

/**
 * Процедура старта (§14, дословно шаги 1-4; шаг 5 — переподписка WS-водяного знака — забота
 * задачи 3/main.ts, не этой функции): читает `position/list`+`order/realtime`, сливает с локальным
 * журналом LIVE-сделок (см. комментарий вверху файла про 'K'-префикс) и чинит журнал по бирже.
 * Одна транзакция БД — либо весь эффект коммитится, либо ничего (крэш посреди реконсиляции не
 * оставляет "половину" исправлений). Сетевые READ-вызовы — ДО транзакции (не держат её открытой).
 */
export async function reconcileOnStart(db: Kysely<DB>, rest: ReconcileRestClient): Promise<ReconcileResult> {
  const allPositions = await rest.getPositions()
  const positions = allPositions.filter((p) => new Decimal(p.size).gt(0))
  const openOrders = await rest.getOpenOrders()
  // M1: нужен и внутри транзакции (шаг Б), и ПОСЛЕ её коммита (шаг В, orphan-очистка ниже) —
  // вынесен наружу, а не в двух местах отдельно (DRY).
  const positionSymbols = new Set(positions.map((p) => p.symbol))

  let opened = 0
  let closed = 0
  let flagged = 0

  await db.transaction().execute(async (trx) => {
    const localLiveTrades = await trx
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
      .execute()

    const bySymbol = new Map<string, LocalTrade[]>()
    for (const t of localLiveTrades) {
      const arr = bySymbol.get(t.symbol)
      if (arr) arr.push(t)
      else bySymbol.set(t.symbol, [t])
    }

    // --- Шаг А: что реально открыто на бирже -> сверка/атрибуция/needs_review-флаг. ---
    for (const pos of positions) {
      const allCandidates = bySymbol.get(pos.symbol) ?? []
      const openCandidates = allCandidates.filter((t) => OPEN_STATUSES.has(t.status))

      if (openCandidates.length === 1) {
        const trade = openCandidates[0]!
        if (!positionPredatesLocalOpen(pos, trade.opened_at)) {
          await syncMatchedTrade(trx, trade.channel_id, trade.id, pos)
          continue
        }
      }

      if (openCandidates.length >= 1) {
        // >1 кандидат на один символ ИЛИ единственный отбракован createdTime-защитой — не
        // угадываем, какой из них реальный владелец позиции.
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
    for (const t of localLiveTrades) {
      if (!OPEN_STATUSES.has(t.status)) continue
      if (positionSymbols.has(t.symbol)) continue // уже обработана в шаге А (синк или ambiguous)
      await closeTrade(trx, { tradeId: t.id, status: 'closed' })
      await zeroPositionRow(trx, t.channel_id, t.symbol)
      closed++
    }
  })

  // --- Шаг В (M1, Minor адверсариального ревью): осиротевшие reduceOnly-остатки — ПОСЛЕ коммита
  // транзакции, тот же приём "сеть не держит транзакцию БД", что и cancelAll в
  // private-ws.ts::applyPositionPush. Только reduceOnly (TP/SL/close) — entry/add лимитки того
  // же "бессимвольного" положения НЕ трогаем, они законно ждут первого филла.
  const orphans = openOrders.filter((o) => o.reduceOnly && !positionSymbols.has(o.symbol))
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

  return { opened, closed, flagged, orphansCancelled }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapPositionSide(raw: string): Side | null {
  if (raw === 'Buy') return 'long'
  if (raw === 'Sell') return 'short'
  return null // 'None' — плоская позиция-стаб (сюда не попадаем: positions уже отфильтрован size>0)
}

function positionPredatesLocalOpen(pos: Position, tradeOpenedAt: Date | null): boolean {
  if (tradeOpenedAt === null) return false // opened_at ещё не проставлен — защита неприменима
  const posCreatedMs = Number(pos.createdTime)
  if (!Number.isFinite(posCreatedMs)) return false
  return posCreatedMs < tradeOpenedAt.getTime() - CREATED_TIME_TOLERANCE_MS
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
      leverage, position_status, bybit_seq, updated_at
    ) VALUES (
      ${channelId}, ${pos.symbol}, ${tradeId}::uuid, ${side}::side_t, ${pos.size}::numeric,
      ${pos.avgPrice}::numeric, ${pos.markPrice}::numeric, ${pos.liqPrice}::numeric,
      ${pos.leverage}::numeric, ${pos.positionStatus}, ${pos.seq}, now()
    )
    ON CONFLICT (channel_id, symbol) DO UPDATE SET
      trade_id = EXCLUDED.trade_id,
      side = EXCLUDED.side,
      size = EXCLUDED.size,
      avg_price = EXCLUDED.avg_price,
      mark_price = EXCLUDED.mark_price,
      liq_price = EXCLUDED.liq_price,
      leverage = EXCLUDED.leverage,
      position_status = EXCLUDED.position_status,
      bybit_seq = EXCLUDED.bybit_seq,
      updated_at = now()
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
