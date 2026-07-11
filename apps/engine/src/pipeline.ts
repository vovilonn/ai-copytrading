import { createHash } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network, ParsedIntent, ParseContext, ParsedResult, Side } from 'shared/domain.js'
import { getAdapter } from './adapters/registry.js'
import { normalize } from './normalize.js'
import { resolveSymbol } from './symbol-resolver.js'
import { computeLeverage, floorTo, liqPrice } from './risk/leverage.js'
import { computeSize } from './risk/sizing.js'
import { acquireSymbol, addLeg, closeTrade, openTrade } from './state/trades.js'
import type { ExecutionPort, OrderContext } from './execution/port.js'
import { listInstruments, type InstrumentMap } from './instruments.js'
import { AI_CONFIDENCE_GATE, classifyIntent, reconcile } from './reconciler.js'
import { buildContext } from './ai/context.js'
import { cacheKey, getCached, putCached, type AiCacheSchema } from './ai/cache.js'
import {
  callExtractSignal,
  MODEL_OPUS,
  MODEL_SONNET,
  PROMPT_VERSION,
  type AiCallsSchema,
} from './ai/client.js'
import { normalizeAiOutput } from './ai/normalize-output.js'
import type { ExtractSignalOutput } from './ai/schema.js'

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
  /**
   * Important I2 адверсариального ревью (p3-core-fix-report.md): живой mark price символа —
   * гейт staleness/slippage перед market-входом (см. DEFAULT_MAX_ENTRY_SLIPPAGE_PCT/
   * handleEntrySignal ниже). `undefined` в dry_run (main.ts не подключает сеть в этом режиме —
   * см. PipelineDeps.equity выше про тот же принцип "0 сетевых походов в dry-run") — гейт тогда
   * НЕ применяется, entry_signal ведёт себя ровно как до этого фикса. В live main.ts подставляет
   * `createMarkPriceGetter(rest)` — публичный тикер `GET /v5/market/tickers` (фикс p3-slippage-fix,
   * НЕ стаб-позиция `getPositions`: та отдаёт markPrice="" на аккаунте без истории по символу).
   * Инжектируется функцией (а не готовым значением), т.к. mark price нужен ПЕРЕД каждым входом
   * и может отличаться по символам внутри одного тика. Возврат `null` ФУНКЦИЕЙ (не отсутствие
   * поля целиком) означает сбой похода за ценой — handleEntrySignal ниже трактует это
   * fail-CLOSED (skip mark_price_unavailable), не fail-open.
   */
  getMarkPrice?: (symbol: string) => Promise<string | null>
  /** Порог гейта I2, % (design: дефолт '0.5' = MAX_ENTRY_SLIPPAGE_PCT, .env.example). */
  maxEntrySlippagePct?: string
}

// Important I2 (адверсариальное ревью): вход всегда market по СИГНАЛЬНОЙ цене — если реальный
// mark отклонился от неё больше чем на этот порог (сигнал устарел/цена уже ушла), риск/сайзинг,
// посчитанные по сигнальной цене, больше не отражают реальность — лучше skip, чем вход вслепую.
const DEFAULT_MAX_ENTRY_SLIPPAGE_PCT = '0.5'

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

    // Ф2-финальное ревью (Minor #4): раньше строка возвращала `.returning('id')` только затем,
    // чтобы прокинуть detParseResult.id в runAiBranch (ai_calls.parse_result_id). Теперь ai_calls
    // пишется на ОТДЕЛЬНОМ соединении пула (см. runAiBranch/client.ts::writeAiCall) — эта строка
    // ещё не закоммичена на момент AI-вызова, другое соединение (READ COMMITTED) её не увидит,
    // так что id больше никому не нужен — `.execute()` без `.returning()`.
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

    // AI-ветка (research/ai-layer.md §4/§8/§10/§11, task-4-brief.md): вызываем AI, ТОЛЬКО когда
    // детерминированный адаптер сам не смог построить intent (route==='ai' — терсное/free-form/
    // картинка-only сообщение CH2). CH1 и CH2 A/B/C/D никогда не заходят сюда — деградация AI их
    // не касается (см. runAiBranch — при отказе возвращает null, а не бросает наружу).
    // `db` (родительский пул, НЕ trx) передаётся ЕЩЁ и для ai_calls — см. Minor #4 в runAiBranch.
    const aiBranch = parsed.route === 'ai' ? await runAiBranch(trx, db, message, normalizedText, instruments, channel.adapter_id) : null
    const aiParsed: ParsedResult | null = aiBranch?.parsed ?? null
    // НАХОДКА приёмки задачи 7 (в дополнение к находке задачи 6): extract_signal ВСЕГДА возвращает
    // `summary` (schema.ts: обязательное поле tool-вызова), но до этой правки пайплайн его нигде
    // не читал — messages.ai_summary оставался NULL даже для method='ai' сообщений, и UI (design:
    // sparkles-саммари) никогда не рисовался на реальных данных (см. p2-task7-report.md). Кладём
    // как есть, независимо от исхода реконсиляции (needs_review/skipped/executing) — саммари
    // описывает, что модель УВИДЕЛА в сообщении, это полезно оператору и в needs_review-кейсе.
    const aiSummary: string | null = aiBranch?.summary ?? null

    const decision = reconcile(parsed, aiParsed, { channelId: message.channelId })
    const now = new Date()

    if (decision.outcome === 'noise') {
      await trx
        .updateTable('messages')
        .set({ status: 'noise', normalized_text: normalizedText, method: decision.method, ai_summary: aiSummary, updated_at: now })
        .where('id', '=', message.id)
        .execute()
      return
    }

    if (decision.outcome === 'needs_review') {
      // НАХОДКА задачи 6 (закрыта здесь, task-7-brief.md п.1): раньше needs_review возвращался
      // БЕЗ actions-строки — оператор не видел в UI ни таймлайна, ни /actions, что сообщение
      // непонято/спорно (UNKNOWN, parser_disagreement, ai_unavailable, needs_human, low_confidence).
      // Пишем ту же синтетическую "весь месседж" строку, что и для skip (ensureWholeMessageAction
      // ниже), status='needs_review', skip_reason=decision.reason — фронт (action-display.tsx:
      // isNeedsReviewReason) уже умеет рисовать по этому skip_reason бейдж "Needs review" вместо
      // "Skipped" (задача 6), достаточно, чтобы строка вообще существовала.
      // decision.method здесь всегда 'review' (reconciler.ts: все needs_review-ветки возвращают
      // method:'review') — берём defensively, тем же приёмом, что и у method ниже для skipped.
      const method: 'review' = decision.method === 'review' ? decision.method : 'review'
      const created = await ensureWholeMessageAction(trx, message, decision.reason ?? 'needs_review', method, 'needs_review')
      if (created) notifyNeeded = true
      await trx
        .updateTable('messages')
        .set({
          status: 'needs_review',
          status_reason: decision.reason ?? null,
          normalized_text: normalizedText,
          method: decision.method,
          ai_summary: aiSummary,
          updated_at: now,
        })
        .where('id', '=', message.id)
        .execute()
      return
    }

    if (decision.outcome === 'skipped') {
      // decision.method здесь всегда 'auto' либо 'ai' (reconciler.ts) — never null/'review'.
      const method: 'auto' | 'ai' = decision.method === 'ai' ? 'ai' : 'auto'
      const created = await ensureWholeMessageAction(trx, message, decision.reason ?? 'skip', method, 'skipped')
      if (created) notifyNeeded = true
      await trx
        .updateTable('messages')
        .set({
          status: 'skipped',
          status_reason: decision.reason ?? null,
          normalized_text: normalizedText,
          method,
          ai_summary: aiSummary,
          updated_at: now,
        })
        .where('id', '=', message.id)
        .execute()
      return
    }

    // decision.outcome === 'executing' — decision.method всегда 'auto' либо 'ai' (never null/'review').
    const method: 'auto' | 'ai' = decision.method === 'ai' ? 'ai' : 'auto'
    const base: IntentBase = { message, channel, settings, instruments, deps }
    // Гейт "Copy trading" (channel_settings.enabled, DEFAULT false — design spec: "off → каждый
    // action Skipped, ордера не отправляются"). Сообщение по-прежнему парсится и actions
    // пишутся (нужны UI/таймлайну), но ни один intent НЕ доходит до handleEntrySignal/handleDelta —
    // ExecutionPort не вызывается, символ не захватывается, trade/position не создаются.
    const copySkipReason = settings.enabled === false ? 'copy_disabled' : undefined
    for (const { actionIndex, intent } of decision.decided) {
      const emitted = await processIntent(trx, base, actionIndex, intent, method, copySkipReason)
      if (emitted) notifyNeeded = true
    }

    await trx
      .updateTable('messages')
      .set({ status: 'executed', normalized_text: normalizedText, method, ai_summary: aiSummary, updated_at: now })
      .where('id', '=', message.id)
      .execute()
  })

  if (notifyNeeded) {
    await sql`SELECT pg_notify('domain_events', '')`.execute(db)
  }
}

// ---------------------------------------------------------------------------
// AI-ветка (research/ai-layer.md §4/§8/§10/§11, task-4-brief.md): route==='ai' от адаптера ->
// buildContext -> кэш -> callExtractSignal (Sonnet, эскалация Opus одним повтором) ->
// normalizeAiOutput -> putCached -> вторая строка parse_results(parser='ai').
// ---------------------------------------------------------------------------

/** Эскалация Sonnet→Opus (research §8, дословно): needs_human ИЛИ хотя бы один action с
 *  symbol==='UNKNOWN' ИЛИ confidence < AI_CONFIDENCE_GATE. Проверяется на СЫРОМ выводе модели
 *  (ДО normalizeAiOutput) — ровно те три поля, что перечислены в исследовании. */
function needsEscalation(output: ExtractSignalOutput): boolean {
  if (output.needs_human) return true
  if (output.confidence < AI_CONFIDENCE_GATE) return true
  return output.actions.some((a) => a.symbol === 'UNKNOWN')
}

/** Результат успешной AI-ветки: и канонический разбор для reconciler'а, и `summary` от модели
 *  (schema.ts: extract_signal.summary, обязательное поле) — приёмка задачи 7 обнаружила, что
 *  пайплайн раньше нигде не читал `output.summary`, из-за чего `messages.ai_summary` оставался
 *  NULL и sparkles-саммари (design) никогда не рендерился на реальных данных, см. отчёт. */
interface AiBranchResult {
  parsed: ParsedResult
  summary: string
}

/**
 * Выполняет AI-ветку для ОДНОГО сообщения (route==='ai' у детерминированного адаптера).
 *
 * ДЕГРАДАЦИЯ (критично, research §11 fail-safe): если callExtractSignal бросает даже ПОСЛЕ
 * исчерпания своих внутренних ретраев (client.ts: 4 попытки, backoff 2^att c, на 429/500/502/
 * 503/529/сетевые сбои) — эта функция ЛОВИТ исключение и возвращает `null`, а НЕ пробрасывает
 * его наружу. Причина: пробрасывание уронило бы ВСЮ транзакцию processMessage (включая уже
 * записанную детерминированную строку parse_results), а reconcile(parsed, null, ctx) для
 * route==='ai' сам корректно доводит сообщение до outcome 'needs_review' (reason
 * 'ai_unavailable') — сообщение НЕ теряется, статус переобрабатываемый, 0 ордеров. CH1 и
 * CH2-A/B/C/D сообщения в этом же тике/канале НЕ используют эту функцию вовсе — отказ AI их
 * не блокирует (детерминированный путь независим).
 *
 * Порядок вызова (§10): buildContext (позиции+reply+картинки) -> cacheKey -> getCached ->
 * (промах) callExtractSignal(Sonnet) -> при needsEscalation ОДНИМ повтором callExtractSignal
 * (Opus) -> putCached финальным (возможно эскалированным) результатом -> normalizeAiOutput ->
 * вторая строка parse_results(parser='ai', prompt_version) для трассировки/UI.
 *
 * Minor #4 адверсариального ревью (p2-final-fix-report.md, выбран вариант (а)): `pool` —
 * родительский НЕтранзакционный Kysely (тот самый `db`, который processMessage получил
 * аргументом), отдельный от `trx` этого сообщения. ai_calls (учёт стоимости AI-вызова) пишется
 * ИМЕННО через `pool`, а НЕ через `trx` — упавший insert в ai_calls (напр. временная проблема
 * БД) не отравляет транзакцию сообщения (PG аварийно завершает только СВОЁ соединение), а сам
 * учёт стоимости не теряется, если trx сообщения позже откатится по другой причине — деньги на
 * AI уже потрачены независимо от судьбы этой транзакции. ai_cache (getCached/putCached) и вторая
 * строка parse_results(parser='ai') ниже остаются на `trx` — это часть детерминированного эффекта
 * сообщения (либо коммитятся вместе с остальным, либо откатываются вместе), а putCached к тому же
 * идемпотентен (ON CONFLICT DO NOTHING, cache.ts) и не может отравить транзакцию задвоением ключа.
 */
async function runAiBranch(
  trx: Kysely<DB>,
  pool: Kysely<DB>,
  message: PipelineMessage,
  normalizedText: string,
  instruments: InstrumentMap,
  adapterId: string,
): Promise<AiBranchResult | null> {
  try {
    const aiContext = await buildContext(trx, {
      id: message.id,
      channelId: message.channelId,
      replyToMsgId: message.replyToMsgId,
    })

    // "media_ids" ключа кэша (research §10) — sha256 БАЙТОВ картинки (комментарий cache.ts
    // явно допускает это как эквивалент message_media.id): не требует отдельного похода в БД за
    // message_media, buildContext уже прочитал файлы с диска.
    const mediaIds = aiContext.images.map((img) => createHash('sha256').update(img.base64, 'base64').digest('hex'))

    const key = cacheKey({
      model: MODEL_SONNET,
      normalizedText,
      mediaIds,
      replyParentId: message.replyToMsgId,
      openPositionsHash: aiContext.openPositionsHash,
      promptVersion: PROMPT_VERSION,
    })

    const cacheDb = trx as unknown as Kysely<AiCacheSchema>
    // Minor #4: ai_calls — на `pool`, НЕ на `trx` (см. комментарий над функцией). Следствие:
    // ai_calls.parse_result_id для AI-вызовов теперь всегда null — строка parse_results
    // (parser='deterministic', выше в processMessage) ещё не закоммичена на момент этого вызова
    // (тот же trx), а `pool` — другое соединение (READ COMMITTED) её не видит; FK на
    // незакоммиченную строку упал бы. Поле нигде не читается (только пишется) в apps/api|apps/web
    // (проверено ревью) — потеря линковки безопасна, ai_calls.message_id (FK на УЖЕ закоммиченную
    // ingest'ом строку messages) остаётся и достаточен для трассировки по сообщению.
    const callsDb = pool as unknown as Kysely<AiCallsSchema>

    let output = await getCached(cacheDb, key)
    if (!output) {
      const callBase = {
        text: message.text,
        tMsg: message.msgTs.toISOString(),
        ...(aiContext.replyParentText !== undefined ? { replyParentText: aiContext.replyParentText } : {}),
        openPositions: aiContext.openPositions,
        images: aiContext.images,
        db: callsDb,
        messageId: message.id,
      }

      const first = await callExtractSignal({ ...callBase, model: MODEL_SONNET })
      output = first.output
      let finalModel = MODEL_SONNET

      // Эскалация ОДНИМ повтором (заметка задачи 2: normalizeAiOutput всё равно смаппит
      // остаточную неопределённость Opus-ответа в route 'ai' -> needs_review реконсилером, второй
      // эскалации/повторного вызова НЕТ — не зацикливаемся).
      if (needsEscalation(output)) {
        const escalated = await callExtractSignal({ ...callBase, model: MODEL_OPUS, escalated: true })
        output = escalated.output
        finalModel = MODEL_OPUS
      }

      await putCached(cacheDb, key, output, finalModel, PROMPT_VERSION)
    }

    const aiParsed = normalizeAiOutput(output, {
      isListed: (symbol: string) => instruments.get(symbol)?.status === 'Trading',
    })

    await trx
      .insertInto('parse_results')
      .values({
        message_id: message.id,
        parser: 'ai',
        adapter_id: adapterId,
        route: aiParsed.route,
        confidence: aiParsed.confidence.toString(),
        intents: JSON.stringify(aiParsed.intents),
        reason: aiParsed.reason ?? null,
        needs_vision: aiParsed.needsVision ?? false,
        prompt_version: PROMPT_VERSION,
      })
      .execute()

    return { parsed: aiParsed, summary: output.summary }
  } catch (err) {
    // Алерт в лог (задача просит "алерт в лог", отдельная алертинг-инфраструктура вне границ
    // этой задачи) — без него отказ AI был бы виден только по накоплению needs_review в UI.
    console.error(
      `[pipeline] AI недоступен для сообщения ${message.id} (tg=${message.tgMessageId}, канал ${message.channelId}): ${(err as Error).message}`,
    )
    return null
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
// Целиком отвергнутое ИЛИ спорное сообщение (route==='skip' -> status skipped; outcome
// needs_review -> status needs_review, задача 6/7). ParsedResult.intents в обоих случаях всегда [].
// ---------------------------------------------------------------------------

/** @returns true, если строка actions реально создана этим вызовом (а не уже существовала). */
async function ensureWholeMessageAction(
  trx: Kysely<DB>,
  message: PipelineMessage,
  reason: string,
  method: 'auto' | 'ai' | 'review',
  status: 'skipped' | 'needs_review',
): Promise<boolean> {
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
      // symbol_unknown/symbol_not_listed/incomplete_signal) происходит из R1 (попытка входа), а
      // needs_review-исходы (UNKNOWN/parser_disagreement/ai_unavailable/needs_human/low_confidence)
      // по той же причине не несут восстановимого symbol/kind — action_type NOT NULL в схеме
      // (миграция 001_initial.ts) не допускает null, точнее классифицировать здесь нечем, см.
      // отчёт по задаче 7.
      type: 'open',
      side: null,
      symbol: null,
      pair: null,
      method,
      status,
      skip_reason: reason,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await trx
    .insertInto('domain_events')
    .values({
      // Один и тот же event И для skipped, И для needs_review — фронт (apps/web/src/lib/ws.ts)
      // слушает 'action.skipped' как сигнал "эта action-строка в терминальном состоянии без
      // исполнения, перечитай список" безотносительно конкретного status/skip_reason.
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

interface HandlerResult {
  skipReason?: string
  tradeId?: string
  side?: Side
  symbol?: string
}

// classifyIntent(intent) (symbol/side/type ActionType) — единственный источник этой классификации
// (DRY), перенесён в reconciler.ts (нужен И там для сравнения det/ai при реконсиляции, И здесь для
// заполнения actions.type/side/symbol) — см. импорт вверху файла.

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
 * @param method Method итоговой Decision ('auto' — детерминированный путь, 'ai' — AI-путь) —
 *   пишется в actions.method (design spec §6 / research §12 UI-поле "Method").
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
  method: 'auto' | 'ai',
  forceSkipReason?: string,
): Promise<boolean> {
  const existing = await trx
    .selectFrom('actions')
    .select('id')
    .where('message_id', '=', base.message.id)
    .where('action_index', '=', actionIndex)
    .executeTakeFirst()
  if (existing) return false

  const info = classifyIntent(intent)
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
      method,
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
        // 'add'/'limit_entry'/'market_entry' — CH2/Ф2 типы: и детерминированные правила B/C
        // ch2.adapter.ts (задача 3), и AI (normalizeAiOutput mapOpenAction/mapAddAction, задача 2)
        // МОГУТ их производить. Открытие новой позиции/добор через них — отдельный сайзинг-режим
        // (channel_settings.add_sizing_mode), вне границ ЭТОЙ задачи (reconciler+AI-ветка+
        // деградация, task-4-brief.md): needs_review-подобный skip, а не молчаливый крэш и не
        // угадывание риска/размера — "лучше needs_review, чем неверное исполнение" (research §11).
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

  // Important I2 адверсариального ревью (p3-core-fix-report.md): вход всегда market по
  // СИГНАЛЬНОЙ цене — риск/сайзинг ниже считаются от entryPrice, а реальный филл может быть
  // далеко, если сигнал протух (staleness) или цена уже ушла (slippage). Гейт применяется ТОЛЬКО
  // когда есть живой источник цены (live, deps.getMarkPrice подключён main.ts) — dry_run НЕ
  // вызывает его вовсе (fail-open, dry_run не имеет и не должен иметь сетевого пути к бирже, см.
  // PipelineDeps.equity выше). Фикс p3-slippage-fix (Important, найден e2e): если getMarkPrice
  // ПОДКЛЮЧЁН, но сам вызов вернул null (сбой похода за ценой/пустой тикер, main.ts::
  // createMarkPriceGetter) — гейт теперь fail-CLOSED (skip mark_price_unavailable), а НЕ
  // fail-open, как было раньше. Раньше null тихо пропускал проверку отклонения — торговая
  // система не должна входить вслепую, если не может достоверно узнать текущую цену.
  if (base.deps.getMarkPrice) {
    const currentMark = await base.deps.getMarkPrice(intent.symbol)
    if (currentMark === null) return { skipReason: 'mark_price_unavailable' }
    const maxSlippagePct = new Decimal(base.deps.maxEntrySlippagePct ?? DEFAULT_MAX_ENTRY_SLIPPAGE_PCT)
    const deviationPct = new Decimal(currentMark).minus(entryPrice).abs().div(entryPrice).mul(100)
    if (deviationPct.gt(maxSlippagePct)) return { skipReason: 'price_slippage' }
  }

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
    // Critical C1 адверсариального ревью (p3-core-fix-report.md): SL идёт АТОМАРНО вместе со
    // входом (BybitAdapter передаёт его прямо в теле order/create) — либо позиция открывается уже
    // защищённой, либо не открывается вовсе. Раньше здесь были ТРИ последовательных сетевых
    // вызова (placeEntry -> placeTpLadder -> setStopLoss) в одной БД-транзакции: гонка "нулевая
    // позиция сразу после market-входа" могла уронить setStopLoss, а детерминированный отказ SL
    // откатывал транзакцию -> replay -> тот же детерминированный отказ -> бесконечный цикл при
    // ЖИВОЙ незащищённой позиции на бирже (см. отчёт). Отдельного setStopLoss после TP-лесенки
    // больше нет — если TP-лесенка ниже всё же не поставится, позиция УЖЕ защищена этим SL.
    stopLoss: sl.toString(),
  })

  if (intent.tps.length > 0) {
    const tpTargets = buildTpTargets(sizeResult.qty, intent.tps, instrument.qtyStep)
    if (tpTargets.length > 0) {
      await base.deps.executionPort.placeTpLadder(trx, { ...orderCtx, tps: tpTargets })
    }
  }

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

// Приоритет op'ов для actions.type (OP_PRIORITY/OP_TYPE) и primaryOp — перенесены в
// reconciler.ts (classifyIntent) — единственный источник этой классификации (DRY), см. импорт
// вверху файла.

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
      case 'tp_set':
        // modify_tp (Ф2, AI-канал: "Следующие цели 72.7, 74") — полная замена TP-лесенки.
        // Примитивы по отдельности (не весь `position`) — trade_id уже сужен до string выше
        // (гейт no_open_position), а structural-check целого объекта эту сузку не видит.
        await handleTpSet(trx, base, orderCtx, intent.symbol, position.trade_id, position.size, position.mark_price, op.targets)
        break
      case 'cancel_pending': {
        // Отмена ЕЩЁ НЕ исполненного pending-ордера (лимитный вход/добор) — НЕ путать с
        // sl_cancel выше (тот снимает уже выставленный стоп-лосс). Ищем последний незакрытый
        // entry/add-ордер сделки; если такого нет (уже исполнен/сделки не было) — no-op.
        const pendingEntry = await trx
          .selectFrom('orders')
          .select('order_link_id')
          .where('trade_id', '=', position.trade_id)
          .where('purpose', 'in', ['entry', 'add'])
          .where('status', 'in', ['created', 'pending_submit', 'submitted'])
          .orderBy('created_at', 'desc')
          .executeTakeFirst()
        if (pendingEntry) await base.deps.executionPort.cancelOrder(trx, { orderLinkId: pendingEntry.order_link_id })
        break
      }
      case 'hold':
        break // явный no-op (research: "hold — никогда не исполняется как ордер")
    }
  }

  return { tradeId: position.trade_id, side: position.side, symbol: intent.symbol }
}

/**
 * modify_tp (research/ai-layer.md §3, задача 4) — ПОЛНАЯ замена TP-лесенки: отменяет ВСЕ
 * активные TP-ордера сделки и ставит новую на op.targets, поровну разделив ТЕКУЩИЙ остаток
 * позиции (buildTpTargets — та же функция, что и вход, отбрасывает нулевые доли при грубом
 * qtyStep). marker='current_price' резолвится в positions.mark_price (живой тикер, задача 10);
 * если хотя бы одна цель не резолвилась (current_price без живого mark_price ещё) — операция
 * НЕ выполняется вовсе (старая лесенка остаётся нетронутой) — fail-safe (research §11: "лучше
 * needs_review/no-op, чем неверное исполнение"), не гадаем на устаревшей/отсутствующей цене.
 */
async function handleTpSet(
  trx: Kysely<DB>,
  base: IntentBase,
  orderCtx: OrderContext,
  symbol: string,
  tradeId: string,
  size: string,
  markPriceRaw: string | null,
  targets: ReadonlyArray<{ value?: number; marker?: 'current_price' }>,
): Promise<void> {
  const markPrice = markPriceRaw !== null ? new Decimal(markPriceRaw) : null
  const prices: Decimal[] = []
  for (const target of targets) {
    if (target.value !== undefined) {
      prices.push(new Decimal(target.value))
    } else if (target.marker === 'current_price' && markPrice !== null) {
      prices.push(markPrice)
    }
  }
  if (prices.length !== targets.length || prices.length === 0) {
    console.warn(`[pipeline] modify_tp: не все цели резолвились (current_price без mark_price?), symbol=${symbol} — лесенка не обновлена`)
    return
  }

  const instrument = base.instruments.get(symbol)
  if (!instrument) return // символ вне листинга — не должно происходить (позиция уже открыта на нём)

  const activeTps = await trx
    .selectFrom('orders')
    .select('order_link_id')
    .where('trade_id', '=', tradeId)
    .where('purpose', '=', 'tp')
    .where('status', 'in', ['created', 'pending_submit', 'submitted'])
    .execute()
  for (const activeTp of activeTps) {
    await base.deps.executionPort.cancelOrder(trx, { orderLinkId: activeTp.order_link_id })
  }

  const tpTargets = buildTpTargets(new Decimal(size), prices.map((p) => p.toNumber()), instrument.qtyStep)
  if (tpTargets.length > 0) {
    await base.deps.executionPort.placeTpLadder(trx, { ...orderCtx, tps: tpTargets })
  }
}
