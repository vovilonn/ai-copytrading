import { Decimal } from 'decimal.js'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { ActionType, DeltaOp, Network, ParsedIntent, ParseContext, Side } from 'shared/domain.js'
import { getAdapter } from './adapters/registry.js'
import { normalize } from './normalize.js'
import { resolveSymbol } from './symbol-resolver.js'
import { computeLeverage, floorTo, liqPrice } from './risk/leverage.js'
import { computeSize } from './risk/sizing.js'
import { acquireSymbol, addLeg, closeTrade, openTrade } from './state/trades.js'
import type { ExecutionPort, OrderContext } from './execution/port.js'
import { listInstruments, type InstrumentMap } from './instruments.js'
import { reconcile } from './reconciler.js'

/**
 * Пайплайн разбора и исполнения одного сообщения (design spec §6, task-7-brief.md):
 * adapter.parse(сырой текст) → reconcile → (на каждый intent) risk → ExecutionPort. Одна
 * транзакция на сообщение — либо весь эффект (parse_results/actions/trades/orders/positions/
 * domain_events) коммитится целиком, либо ничего (крэш посреди обработки не оставляет "половину"
 * сделки в БД). NOTIFY по domain_events шлётся СТРОГО после коммита (тот же приём, что и
 * apps/tg-ingest/src/ingest.service.ts — иначе слушатель получит уведомление раньше, чем
 * увидит строку своим собственным SELECT).
 *
 * normalize() здесь считается ОТДЕЛЬНО и пишется в messages.normalized_text (см. ниже) —
 * это ДИАГНОСТИЧЕСКОЕ поле для отладки/UI, а не вход парсера: adapter.parse(ctx) получает
 * СЫРОЙ message.text (buildParseContext/toParseContextMessage ниже кладут row.text как есть).
 * Так и должно быть — regex CH1 (ch1.adapter.ts) требуют исходный регистр `#TICKER/USDT`,
 * а normalize() лоуэркейсит текст целиком; примени её к парсингу — и CH1 перестанет матчить
 * собственные сигналы. Нормализация текста под парсинг — забота КОНКРЕТНОГО адаптера (CH2 в
 * Ф2 применит её сам к своему свободному тексту), не общего шага ядра.
 */

export interface PipelineMessage {
  id: string
  channelId: number
  tgMessageId: number
  replyToMsgId: number | null
  groupedId: string | null
  text: string
  mediaKind: string | null
  msgTs: Date
}

export interface PipelineDeps {
  executionPort: ExecutionPort
  network: Network
  /**
   * Equity сабаккаунта канала для риск-сайзинга (design spec §8: "Риск% × equity_субаккаунта").
   * В Ф1 у каналов ещё нет реальных Bybit-сабаккаунтов (провижининг — Ф3), поэтому здесь —
   * фиксированная заглушка (совпадает с суммой, которой реально пополнен testnet-аккаунт, см.
   * LOOP_STATE.md: "1000 USDT"), а не живой запрос `wallet-balance`. Как только Ф3 заведёт
   * сабаккаунты, это поле заменится на живой баланс — сигнатура ExecutionPort/pipeline не изменится.
   */
  equity: string
}

type ChannelRow = Selectable<DB['channels']>
type ChannelSettingsRow = Selectable<DB['channel_settings']>

export async function processMessage(db: Kysely<DB>, message: PipelineMessage, deps: PipelineDeps): Promise<void> {
  let notifyNeeded = false

  await db.transaction().execute(async (trx) => {
    const channel = await trx
      .selectFrom('channels')
      .selectAll()
      .where('id', '=', message.channelId)
      .executeTakeFirstOrThrow()
    const settings = await trx
      .selectFrom('channel_settings')
      .selectAll()
      .where('channel_id', '=', message.channelId)
      .executeTakeFirstOrThrow()
    const adapter = getAdapter(channel.adapter_id)
    const instruments = await listInstruments(trx, deps.network)

    const ctx = await buildParseContext(trx, message, instruments)
    const normalizedText = normalize(message.text)
    const parsed = adapter.parse(ctx)

    await trx
      .insertInto('parse_results')
      .values({
        message_id: message.id,
        parser: 'deterministic',
        adapter_id: channel.adapter_id,
        route: parsed.route,
        confidence: parsed.confidence.toString(),
        intents: JSON.stringify(parsed.intents),
        reason: parsed.reason ?? null,
        needs_vision: parsed.needsVision ?? false,
      })
      .execute()

    const decision = reconcile(parsed, { channelId: message.channelId })
    const now = new Date()

    if (decision.outcome === 'noise') {
      await trx
        .updateTable('messages')
        .set({ status: 'noise', normalized_text: normalizedText, method: null, updated_at: now })
        .where('id', '=', message.id)
        .execute()
      return
    }

    if (decision.outcome === 'needs_review') {
      await trx
        .updateTable('messages')
        .set({ status: 'needs_review', normalized_text: normalizedText, method: null, updated_at: now })
        .where('id', '=', message.id)
        .execute()
      return
    }

    if (decision.outcome === 'skipped') {
      const created = await ensureWholeMessageSkipped(trx, message, decision.skipReason ?? 'skip')
      if (created) notifyNeeded = true
      await trx
        .updateTable('messages')
        .set({
          status: 'skipped',
          status_reason: decision.skipReason ?? null,
          normalized_text: normalizedText,
          method: 'auto',
          updated_at: now,
        })
        .where('id', '=', message.id)
        .execute()
      return
    }

    // decision.outcome === 'executing'
    const base: IntentBase = { message, channel, settings, instruments, deps }
    // Гейт "Copy trading" (channel_settings.enabled, DEFAULT false — design spec: "off → каждый
    // action Skipped, ордера не отправляются"). Сообщение по-прежнему парсится и actions
    // пишутся (нужны UI/таймлайну), но ни один intent НЕ доходит до handleEntrySignal/handleDelta —
    // ExecutionPort не вызывается, символ не захватывается, trade/position не создаются.
    const copySkipReason = settings.enabled === false ? 'copy_disabled' : undefined
    for (const { actionIndex, intent } of decision.decided) {
      const emitted = await processIntent(trx, base, actionIndex, intent, copySkipReason)
      if (emitted) notifyNeeded = true
    }

    await trx
      .updateTable('messages')
      .set({ status: 'executed', normalized_text: normalizedText, method: 'auto', updated_at: now })
      .where('id', '=', message.id)
      .execute()
  })

  if (notifyNeeded) {
    await sql`SELECT pg_notify('domain_events', '')`.execute(db)
  }
}

// ---------------------------------------------------------------------------
// ParseContext — собирается из текущего состояния БД (research §10: адаптер не знает про
// БД/Bybit, всё разрешение — забота ядра).
// ---------------------------------------------------------------------------

function toParseContextMessage(row: {
  tgMessageId: number
  text: string
  msgTs: Date
  replyToMsgId: number | null
  groupedId: string | null
  mediaKind: string | null
}): ParseContext['message'] {
  return {
    id: row.tgMessageId,
    text: row.text,
    date: row.msgTs.toISOString(),
    replyToMsgId: row.replyToMsgId,
    groupedId: row.groupedId,
    media: row.mediaKind,
    // Путь файла медиа CH1 не читает (регэксп-парсер, без vision) — реальный storage_path
    // потребуется только CH2/AI (Ф2), не расширяем PipelineMessage под неиспользуемое поле.
    mediaFile: null,
  }
}

async function buildParseContext(trx: Kysely<DB>, message: PipelineMessage, instruments: InstrumentMap): Promise<ParseContext> {
  const replyTarget =
    message.replyToMsgId !== null
      ? await trx
          .selectFrom('messages')
          .select(['tg_message_id', 'text', 'msg_ts', 'reply_to_msg_id', 'grouped_id', 'media_kind'])
          .where('channel_id', '=', message.channelId)
          .where('tg_message_id', '=', message.replyToMsgId)
          .executeTakeFirst()
      : undefined

  // openPositions — глобальная (across all channels) видимость открытых позиций по символу
  // (research §10: нужна для CH2/Ф2, чтобы не отдать чужой символ другому каналу молча). CH1
  // это поле не читает (символ всегда явный, из #TICKER), но контракт ParseContext требует его
  // заполнить настоящими данными для будущих адаптеров.
  const openPositionRows = await trx
    .selectFrom('positions')
    .select(['symbol', 'trade_id', 'side', 'channel_id'])
    .where(sql<boolean>`size <> 0`)
    .execute()
  const openPositions = new Map(
    openPositionRows
      .filter((r): r is typeof r & { trade_id: string; side: Side } => r.trade_id !== null && r.side !== null)
      .map((r) => [r.symbol, { tradeId: r.trade_id, side: r.side, openedByChannel: String(r.channel_id) }]),
  )

  return {
    channelId: String(message.channelId),
    message: toParseContextMessage({
      tgMessageId: message.tgMessageId,
      text: message.text,
      msgTs: message.msgTs,
      replyToMsgId: message.replyToMsgId,
      groupedId: message.groupedId,
      mediaKind: message.mediaKind,
    }),
    // ctx.resolveSymbol — ЧИСТОЕ разрешение алиаса (research §10), БЕЗ гейта по листингу: гейт —
    // отдельно через ctx.isListed ниже. resolveSymbol(raw, isListed) из symbol-resolver.ts
    // объединяет оба шага сам по себе (возвращает null и для "неизвестно", и для "не торгуется") —
    // поэтому сюда передаём заведомо true (тот же приём, что ch1.adapter.test.ts:alwaysListed),
    // иначе адаптер не смог бы отличить symbol_unknown от symbol_not_listed (оба схлопнулись бы
    // в null и адаптер всегда репортил бы 'symbol_unknown', что и произошло при первой попытке —
    // см. отчёт по задаче 7).
    resolveSymbol: (raw: string) => resolveSymbol(raw, () => true),
    isListed: (symbol: string) => instruments.get(symbol)?.status === 'Trading',
    getMessage: (id: number) =>
      replyTarget && replyTarget.tg_message_id === id
        ? toParseContextMessage({
            tgMessageId: replyTarget.tg_message_id,
            text: replyTarget.text,
            msgTs: replyTarget.msg_ts,
            replyToMsgId: replyTarget.reply_to_msg_id,
            groupedId: replyTarget.grouped_id,
            mediaKind: replyTarget.media_kind,
          })
        : null,
    openPositions,
    // "Последний тронутый символ" — эвристика CH2 (Ф2), доказанно промахивается на реальном
    // дампе (research: сообщение 221447) — в Ф1 не отслеживаем, всегда null.
    lastTouchedSymbol: null,
  }
}

// ---------------------------------------------------------------------------
// Целиком отвергнутое сообщение (route==='skip', ParsedResult.intents всегда []).
// ---------------------------------------------------------------------------

/** @returns true, если строка actions реально создана этим вызовом (а не уже существовала). */
async function ensureWholeMessageSkipped(trx: Kysely<DB>, message: PipelineMessage, reason: string): Promise<boolean> {
  const existing = await trx
    .selectFrom('actions')
    .select('id')
    .where('message_id', '=', message.id)
    .where('action_index', '=', 0)
    .executeTakeFirst()
  if (existing) return false // повторный прогон того же сообщения — идемпотентность

  const inserted = await trx
    .insertInto('actions')
    .values({
      message_id: message.id,
      channel_id: message.channelId,
      action_index: 0,
      // 'open' — лучшее приближение: подавляющее большинство skip-исходов CH1 (no_SL/
      // symbol_unknown/symbol_not_listed/incomplete_signal) происходит из R1 (попытка входа).
      // ParsedResult НЕ сохраняет исходные symbol/kind на skip-ветке (ch1.adapter.ts, задача 3,
      // не переписываем) — точнее классифицировать здесь нечем, см. отчёт по задаче 7.
      type: 'open',
      side: null,
      symbol: null,
      pair: null,
      method: 'auto',
      status: 'skipped',
      skip_reason: reason,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await trx
    .insertInto('domain_events')
    .values({
      type: 'action.skipped',
      aggregate: 'action',
      aggregate_id: inserted.id,
      payload: JSON.stringify({ channelId: message.channelId, actionId: inserted.id, messageId: message.id, pair: null, reason }),
    })
    .execute()
  return true
}

// ---------------------------------------------------------------------------
// Intent -> actions/orders/trades/positions.
// ---------------------------------------------------------------------------

interface IntentBase {
  message: PipelineMessage
  channel: ChannelRow
  settings: ChannelSettingsRow
  instruments: InstrumentMap
  deps: PipelineDeps
}

interface IntentDescription {
  type: ActionType
  side: Side | null
  symbol: string | null
}

interface HandlerResult {
  skipReason?: string
  tradeId?: string
  side?: Side
  symbol?: string
}

function describeIntent(intent: ParsedIntent): IntentDescription {
  switch (intent.kind) {
    case 'entry_signal':
      return { type: 'open', side: intent.side, symbol: intent.symbol }
    case 'delta':
      return { type: OP_TYPE[primaryOp(intent.ops)], side: null, symbol: intent.symbol }
    case 'add':
      return { type: 'add', side: null, symbol: intent.symbol }
    case 'limit_entry':
      return { type: 'open', side: intent.side, symbol: intent.symbol }
    case 'market_entry':
      return { type: 'open', side: intent.side, symbol: intent.symbol }
  }
}

function intentParams(intent: ParsedIntent): unknown {
  switch (intent.kind) {
    case 'entry_signal':
      return { entry: intent.entry, tps: intent.tps, sl: intent.sl, riskPct: intent.riskPct }
    case 'delta':
      return { ops: intent.ops, targetTradeId: intent.targetTradeId }
    case 'add':
      return { price: intent.price }
    case 'limit_entry':
      return { price: intent.price }
    case 'market_entry':
      return {}
  }
}

/**
 * Обрабатывает один канонический intent (actionIndex уже назначен reconciler'ом). Идемпотентно:
 * если actions-строка для (message_id, actionIndex) уже существует — предыдущий прогон уже
 * довёл её до терминального состояния, повторно ничего не делаем (не плодим вторую trade/order).
 * @param forceSkipReason Если задан (channel_settings.enabled===false, см. processMessage) —
 *   intent НЕ передаётся в handleEntrySignal/handleDelta вовсе: action сразу помечается skipped
 *   с этой причиной, ExecutionPort не вызывается и символ не захватывается.
 * @returns true, если был опубликован хотя бы один domain_events (нужно ли слать pg_notify).
 */
async function processIntent(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  intent: ParsedIntent,
  forceSkipReason?: string,
): Promise<boolean> {
  const existing = await trx
    .selectFrom('actions')
    .select('id')
    .where('message_id', '=', base.message.id)
    .where('action_index', '=', actionIndex)
    .executeTakeFirst()
  if (existing) return false

  const info = describeIntent(intent)
  const inserted = await trx
    .insertInto('actions')
    .values({
      message_id: base.message.id,
      channel_id: base.message.channelId,
      action_index: actionIndex,
      type: info.type,
      side: info.side,
      symbol: info.symbol,
      pair: info.symbol,
      method: 'auto',
      status: 'executing',
      params: JSON.stringify(intentParams(intent)),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const actionId = inserted.id

  let result: HandlerResult
  if (forceSkipReason) {
    // channel_settings.enabled===false — не заходим ни в один хендлер вовсе (см. processMessage):
    // ExecutionPort не вызывается, символ не захватывается, trade/position не создаются.
    result = { skipReason: forceSkipReason }
  } else {
    switch (intent.kind) {
      case 'entry_signal':
        result = await handleEntrySignal(trx, base, actionIndex, actionId, intent)
        break
      case 'delta':
        result = await handleDelta(trx, base, actionIndex, actionId, intent)
        break
      default:
        // 'add'/'limit_entry'/'market_entry' — типы CH2/Ф2 (AI). Ни один Ф1-адаптер их не
        // производит (ch1.adapter.ts даёт только entry_signal/delta; ch2Stub — всегда route='ai'
        // с пустыми intents), поэтому ветка ниже сейчас недостижима, но исчерпывающий switch
        // (strict TS) требует явного решения на будущее — needs_review, а не молчаливый крэш.
        result = { skipReason: 'not_implemented_phase1' }
    }
  }

  const now = new Date()
  if (result.skipReason) {
    await trx
      .updateTable('actions')
      .set({ status: 'skipped', skip_reason: result.skipReason, updated_at: now })
      .where('id', '=', actionId)
      .execute()
    await trx
      .insertInto('domain_events')
      .values({
        type: 'action.skipped',
        aggregate: 'action',
        aggregate_id: actionId,
        payload: JSON.stringify({
          channelId: base.message.channelId,
          actionId,
          messageId: base.message.id,
          pair: info.symbol,
          reason: result.skipReason,
        }),
      })
      .execute()
    return true
  }

  const finalSide = result.side ?? info.side
  await trx
    .updateTable('actions')
    .set({ trade_id: result.tradeId ?? null, side: finalSide, status: 'executed', executed_at: now, updated_at: now })
    .where('id', '=', actionId)
    .execute()
  await trx
    .insertInto('domain_events')
    .values({
      type: 'action.new',
      aggregate: 'action',
      aggregate_id: actionId,
      payload: JSON.stringify({
        channelId: base.message.channelId,
        actionId,
        messageId: base.message.id,
        tradeId: result.tradeId ?? null,
        type: info.type,
        symbol: info.symbol,
        side: finalSide,
      }),
    })
    .execute()

  if (result.symbol) await emitPositionUpsert(trx, base.message.channelId, result.symbol)
  return true
}

// Экспортирована для переиспользования в apps/engine/src/market-data/apply-tick.ts (задача 10):
// живой тик mark price публикует ТОТ ЖЕ формат position.upsert, что и исполнение сделок здесь —
// один код, читающий актуальную строку positions и пишущий domain_events, вместо двух копий.
export async function emitPositionUpsert(trx: Kysely<DB>, channelId: number, symbol: string): Promise<void> {
  const position = await trx
    .selectFrom('positions')
    .selectAll()
    .where('channel_id', '=', channelId)
    .where('symbol', '=', symbol)
    .executeTakeFirst()
  if (!position) return

  await trx
    .insertInto('domain_events')
    .values({
      type: 'position.upsert',
      aggregate: 'position',
      aggregate_id: `${channelId}:${symbol}`,
      payload: JSON.stringify({
        channelId,
        symbol,
        side: position.side,
        size: position.size,
        avgPrice: position.avg_price,
        markPrice: position.mark_price,
        leverage: position.leverage,
        stopLoss: position.stop_loss,
        tradeId: position.trade_id,
      }),
    })
    .execute()
}

// ---------------------------------------------------------------------------
// entry_signal -> risk -> ExecutionPort.placeEntry/placeTpLadder/setStopLoss
// ---------------------------------------------------------------------------

/** Общие координаты для orderLinkId (order-link-id.ts) — собираются один раз на intent. */
function buildOrderContext(
  base: IntentBase,
  actionIndex: number,
  actionId: string,
  tradeId: string,
  symbol: string,
  side: Side,
): OrderContext {
  return {
    channelId: base.message.channelId,
    channelOrd: base.channel.ord,
    tgMessageId: base.message.tgMessageId,
    actionIndex,
    actionId,
    tradeId,
    symbol,
    side,
  }
}

/**
 * Делит qty поровну на n целей (design spec §9: "равными долями по числу целей"), округляя
 * каждую вниз к qtyStep; последняя цель забирает остаток, чтобы сумма долей точно равнялась
 * входному qty (без этого floor каждой доли по отдельности терял бы qtyStep*n дробных остатков).
 */
function splitQtyEvenly(total: Decimal, n: number, qtyStep: string): Decimal[] {
  if (n <= 0) return []
  const share = floorTo(qtyStep, total.div(n))
  const shares = Array.from({ length: n - 1 }, () => share)
  const last = floorTo(qtyStep, Decimal.max(0, total.minus(share.mul(n - 1))))
  return [...shares, last]
}

/**
 * Строит цели TP-лесенки, отбрасывая доли, которые floor_to(qtyStep, ...) округлил до нуля
 * (Minor #4 адверсариального ревью): при `total/n < qtyStep` splitQtyEvenly отдаёт нулевые
 * доли для первых n-1 целей — без фильтра это были бы мусорные orders-строки с qty='0'.
 * Если ВСЕ доли обнулились (сама позиция меньше qtyStep·n) — не оставляем сделку вовсе без
 * выхода: кладём весь объём в ПОСЛЕДНЮЮ цель лесенки одним TP-ордером (лог — для наблюдаемости,
 * это осознанное отклонение от "равных долей", а не баг). `total` здесь всегда > 0 — это уже
 * sizeResult.qty, гарантированно не-zero_qty (computeSize сам скипнул бы zero_qty раньше).
 */
function buildTpTargets(
  total: Decimal,
  tps: readonly number[],
  qtyStep: string,
): { price: string; qty: string; index: number }[] {
  const n = tps.length
  if (n === 0) return []

  const qtys = splitQtyEvenly(total, n, qtyStep)
  const nonZero = tps
    .map((price, index) => ({ price: price.toString(), qty: (qtys[index] ?? new Decimal(0)).toString(), index }))
    .filter((t) => !new Decimal(t.qty).isZero())
  if (nonZero.length > 0) return nonZero

  const lastIndex = n - 1
  const lastPrice = tps[lastIndex]
  if (lastPrice === undefined) return [] // n===0 уже отсечено выше — сюда не попасть, defensive

  console.warn(
    `[pipeline] TP-лесенка из ${n} целей схлопнута в один TP: qty=${total.toString()} < qtyStep=${qtyStep} · ${n} — ` +
      `равными долями раздать нечего, весь объём уходит в последнюю цель (${lastPrice}).`,
  )
  return [{ price: lastPrice.toString(), qty: total.toString(), index: lastIndex }]
}

async function handleEntrySignal(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  actionId: string,
  intent: Extract<ParsedIntent, { kind: 'entry_signal' }>,
): Promise<HandlerResult> {
  const instrument = base.instruments.get(intent.symbol)
  // Защитный повторный гейт: ctx.isListed(symbol) в самом парсере уже опирается на этот же кэш
  // (buildParseContext), поэтому в норме сюда не попасть с нелистингованным символом — но
  // instruments могли обновиться асинхронно между вызовом adapter.parse() и этой строкой (кэш
  // читается заново на КАЖДЫЙ processMessage, но не на каждый intent внутри одного сообщения).
  if (!instrument || instrument.status !== 'Trading') return { skipReason: 'symbol_not_listed' }
  if (instrument.mmr === null) return { skipReason: 'mmr_unavailable' }

  // Символ уже занят внутри ЭТОГО канала (task-7-brief.md: "если символ занят внутри канала →
  // action.status skipped reason symbol_busy"). Проверяем ДО openTrade — иначе впустую сожгли бы
  // номер human_ref на сигнал, который всё равно не исполнится.
  const busy = await trx
    .selectFrom('symbol_ownership')
    .select('id')
    .where('channel_id', '=', base.message.channelId)
    .where('symbol', '=', intent.symbol)
    .where('released_at', 'is', null)
    .executeTakeFirst()
  if (busy) return { skipReason: 'symbol_busy' }

  // Вход диапазоном без живого тикер-фида (задача 10 — Ф1 его не подключает) — берём середину
  // диапазона как цену симулированного market-филла (research: "entry для лимитки — цена
  // лимитки, для market — текущая цена"; тот же 1.5004 для LIT 2796, что и в sizing.test.ts).
  // Decimal, а НЕ JS-float (Minor #3 адверсариального ревью, CLAUDE.md: "деньги — Decimal/строки")
  // — это единственная денежная величина ядра, которая считалась во float, до этого исправления.
  const entryPrice = Array.isArray(intent.entry)
    ? new Decimal(intent.entry[0]).plus(intent.entry[1]).div(2)
    : new Decimal(intent.entry)
  const sl = new Decimal(intent.sl)

  const leverage = computeLeverage({
    entry: entryPrice.toString(),
    sl: sl.toString(),
    side: intent.side,
    mmr: instrument.mmr,
    channelMaxLev: base.settings.max_leverage,
    instrMaxLev: instrument.maxLeverage,
    leverageStep: instrument.leverageStep,
  })

  // Важный денежный инвариант (Important #1 адверсариального ревью): SL обязан оставаться
  // ЗА ценой ликвидации на выбранном плече, иначе позицию ликвидирует раньше, чем сработает
  // пользовательский стоп. Парсер (ch1.adapter.ts) не проверяет ни сторону, ни дистанцию SL —
  // валидируем здесь, на пороге открытия позиции, ДО burn'а human_ref/символа/ордеров.
  //
  // 1) Сторона SL: long требует sl < entry, short — sl > entry. Ловит, например, вход
  //    "long entry=100 sl=200" (SL выше входа для лонга — физически не стоп, а профит).
  const invalidSide = intent.side === 'long' ? sl.gte(entryPrice) : sl.lte(entryPrice)
  if (invalidSide) return { skipReason: 'invalid_sl_side' }

  // 2) Безопасность: даже при корректной стороне SL может быть настолько далёк от входа
  //    (d = |entry-sl|/entry ≥ ~0.995), что computeLeverage клампит плечо к 1x (нижняя
  //    граница, ниже физически не опуститься) — и цена ликвидации на этом 1x оказывается
  //    ХУЖЕ (ближе ко входу), чем сам SL: "long entry=100 sl=0.4 -> lev=1, liq=0.5 > sl=0.4"
  //    (ликвидация ВЫШЕ стопа для лонга — сработает раньше). Проверяем с небольшим буфером
  //    0.1%, а не впритык — запас на округление/комиссии/проскальзывание.
  const projectedLiq = liqPrice({ entry: entryPrice, side: intent.side, lev: leverage, mmr: instrument.mmr })
  const SAFE_STOP_BUFFER = '0.001'
  const buf = new Decimal(SAFE_STOP_BUFFER)
  const safeStop =
    intent.side === 'long' ? projectedLiq.mul(new Decimal(1).plus(buf)).lt(sl) : projectedLiq.mul(new Decimal(1).minus(buf)).gt(sl)
  if (!safeStop) return { skipReason: 'unsafe_stop' }

  const sizeResult = computeSize({
    ...(intent.riskPct !== undefined ? { riskPct: intent.riskPct.toString() } : {}),
    equity: base.deps.equity,
    tradeSize: base.settings.trade_size,
    entry: entryPrice.toString(),
    sl: sl.toString(),
    lev: leverage,
    minNotional: instrument.minNotional,
    ...(base.settings.max_symbol_notional !== null ? { maxSymbolNotional: base.settings.max_symbol_notional } : {}),
    qtyStep: instrument.qtyStep,
  })
  if ('skip' in sizeResult) return { skipReason: sizeResult.skip }

  const trade = await openTrade(trx, {
    channelId: base.message.channelId,
    symbol: intent.symbol,
    side: intent.side,
    openedActionId: actionId,
    openedMsgId: base.message.id,
  })

  const acquired = await acquireSymbol(trx, { channelId: base.message.channelId, symbol: intent.symbol, tradeId: trade.tradeId })
  if (!acquired) {
    // Пре-чек выше прошёл, но гонку всё же проиграли (в Ф1 при одном писателе-engine практически
    // недостижимо — защита на будущее при масштабировании). Не оставляем "сиротскую" pending-сделку.
    await trx.updateTable('trades').set({ status: 'cancelled' }).where('id', '=', trade.tradeId).execute()
    return { skipReason: 'symbol_busy' }
  }

  const leg = await addLeg(trx, {
    tradeId: trade.tradeId,
    legIndex: 0,
    kind: 'entry',
    sourceMessageId: base.message.id,
    sourceActionId: actionId,
    requestedQty: sizeResult.qty.toString(),
  })

  const orderCtx = buildOrderContext(base, actionIndex, actionId, trade.tradeId, intent.symbol, intent.side)

  await base.deps.executionPort.placeEntry(trx, {
    ...orderCtx,
    purpose: 'entry',
    orderType: 'market',
    qty: sizeResult.qty.toString(),
    price: entryPrice.toString(),
    leverage: leverage.toString(),
    legId: leg.legId,
    // Полировка А (task-11-brief.md): projectedLiq уже посчитан выше для гейта safeStop —
    // переиспользуем то же значение, чтобы positions.liq_price не оставался '—' на UI.
    liqPrice: projectedLiq.toString(),
  })

  if (intent.tps.length > 0) {
    const tpTargets = buildTpTargets(sizeResult.qty, intent.tps, instrument.qtyStep)
    if (tpTargets.length > 0) {
      await base.deps.executionPort.placeTpLadder(trx, { ...orderCtx, tps: tpTargets })
    }
  }

  await base.deps.executionPort.setStopLoss(trx, { ...orderCtx, price: sl.toString(), qty: sizeResult.qty.toString() })

  const now = new Date()
  await trx
    .updateTable('trades')
    .set({
      status: 'open',
      avg_entry: entryPrice.toString(),
      size: sizeResult.qty.toString(),
      initial_size: sizeResult.qty.toString(),
      leverage: leverage.toString(),
      opened_at: now,
    })
    .where('id', '=', trade.tradeId)
    .execute()
  await trx
    .updateTable('trade_legs')
    .set({ status: 'filled', filled_qty: sizeResult.qty.toString(), avg_price: entryPrice.toString(), opened_at: now })
    .where('id', '=', leg.legId)
    .execute()

  return { tradeId: trade.tradeId, side: intent.side, symbol: intent.symbol }
}

// ---------------------------------------------------------------------------
// delta -> резолв открытой позиции по символу -> команда/событие.
// ---------------------------------------------------------------------------

// Приоритет для поля `type` итоговой actions-строки, когда intent несёт НЕСКОЛЬКО ops разом
// (напр. R2 "MET:{fix,close}" — событие partial_close и команда close_remainder одновременно):
// команды важнее событий, close_remainder — самый весомый исход (сделка закрылась).
// tp_set/cancel_pending — новые Ф2-варианты (задача 2, AI-канал, normalize-output.ts): вставлены
// НИЖЕ Ф1-набора по значимости (обновление TP-лесенки/отмена pending-ордера — не так критичны,
// как факт закрытия/SL), сам пайплайн-обработчик появится в задаче 4 (handleDelta их пока не
// исполняет — см. switch(op.op) ниже, где default-ветки для них нет, это осознанно вне
// границ этой задачи).
const OP_PRIORITY: readonly DeltaOp['op'][] = [
  'close_remainder',
  'sl_breakeven',
  'sl_set',
  'sl_cancel',
  'tp_hit',
  'sl_hit',
  'partial_close',
  'tp_set',
  'cancel_pending',
  'hold',
]

const OP_TYPE: Readonly<Record<DeltaOp['op'], ActionType>> = {
  close_remainder: 'close',
  sl_breakeven: 'modify_sl',
  sl_set: 'modify_sl',
  sl_cancel: 'cancel_order',
  tp_hit: 'tp_hit',
  sl_hit: 'sl_hit',
  partial_close: 'partial_close',
  tp_set: 'modify_tp',
  cancel_pending: 'cancel_order',
  hold: 'hold',
}

function primaryOp(ops: readonly DeltaOp[]): DeltaOp['op'] {
  for (const p of OP_PRIORITY) if (ops.some((o) => o.op === p)) return p
  return ops[0]?.op ?? 'hold' // ops никогда не пуст здесь (адаптер гарантирует ops.length>0 для delta-intent)
}

async function handleDelta(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  actionId: string,
  intent: Extract<ParsedIntent, { kind: 'delta' }>,
): Promise<HandlerResult> {
  if (intent.symbol === null) return { skipReason: 'symbol_unresolved' } // CH2/Ф2, недостижимо для CH1

  // "Один символ — один канал": открытая позиция ЭТОГО канала по символу — единственный
  // источник, к какой сделке относится дельта (research §1 R3: "reply даёт линковку к сделке,
  // но она избыточна для CH1 — символ сам определяет позицию").
  const position = await trx
    .selectFrom('positions')
    .selectAll()
    .where('channel_id', '=', base.message.channelId)
    .where('symbol', '=', intent.symbol)
    .where(sql<boolean>`size <> 0`)
    .executeTakeFirst()
  if (!position || position.trade_id === null || position.side === null) {
    // Осиротевшая дельта — нет открытой позиции этого канала по символу (уже закрыта / никогда
    // не открывалась в Ф1: форум с реальным входом не обработан). Не исполняем.
    return { skipReason: 'no_open_position' }
  }

  const orderCtx = buildOrderContext(base, actionIndex, actionId, position.trade_id, intent.symbol, position.side)

  for (const op of intent.ops) {
    switch (op.op) {
      case 'close_remainder':
        await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: position.size })
        await closeTrade(trx, { tradeId: position.trade_id })
        break
      case 'sl_breakeven':
        // Безубыток = средняя цена входа (design spec §6: "LLM не считает арифметику... число
        // подставляет код из состояния позиции").
        if (position.avg_price !== null) {
          await base.deps.executionPort.setStopLoss(trx, { ...orderCtx, price: position.avg_price, qty: position.size })
        }
        break
      case 'sl_set':
        await base.deps.executionPort.setStopLoss(trx, { ...orderCtx, price: op.price.toString(), qty: position.size })
        break
      case 'sl_cancel': {
        const activeSl = await trx
          .selectFrom('orders')
          .select('order_link_id')
          .where('trade_id', '=', position.trade_id)
          .where('purpose', '=', 'sl')
          .where('status', '=', 'submitted')
          .orderBy('created_at', 'desc')
          .executeTakeFirst()
        if (activeSl) await base.deps.executionPort.cancelOrder(trx, { orderLinkId: activeSl.order_link_id })
        break
      }
      case 'tp_hit':
      case 'sl_hit':
      case 'partial_close':
        // СОБЫТИЯ (design spec §9: "«зафиксировал 50%» трактуется как событие... а не как
        // команда"), не команды: в Ф1 нет ни живого тикер-фида, ни реконсиляции исполнений с
        // биржи (это driver реальных tp/sl-филлов, задача 10/Ф3) — наши TP/SL-ордера остаются
        // "submitted" до явной команды (close_remainder/sl_breakeven/...). Событие уже зафиксировано
        // самой actions-строкой (params.ops), доп. действий не требует.
        break
      case 'hold':
        break // явный no-op (research: "hold — никогда не исполняется как ордер")
    }
  }

  return { tradeId: position.trade_id, side: position.side, symbol: intent.symbol }
}
