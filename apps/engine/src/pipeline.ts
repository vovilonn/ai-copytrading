import { createHash } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { Network, ParsedIntent, ParseContext, ParsedResult, Side } from 'shared/domain.js'
import { getAdapter } from './adapters/registry.js'
import { normalize } from './normalize.js'
import { extractCoins, resolveSymbol } from './symbol-resolver.js'
import { computeLeverage, floorTo, liqPrice } from './risk/leverage.js'
import { leverageWithoutSl, protectiveSl } from './risk/protective-sl.js'
import { computeSize } from './risk/sizing.js'
import { acquireSymbol, addLeg, closeTrade, openTrade, releaseSymbol } from './state/trades.js'
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
   * СВОБОДНАЯ маржа аккаунта — потолок размера нового ордера. Не задана (бэктест/dry-run) —
   * потолок не применяется. Отличие от `equity` денежное: депозит включает деньги, уже занятые
   * под открытые позиции, а новый ордер биржа проверяет по свободному остатку.
   */
  availableBalance?: string
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
  /**
   * Порог отклонения рынка от цены сигнала, % — ОПЦИОНАЛЬНЫЙ гейт «сигнал протух, не входим».
   *
   * По умолчанию ВЫКЛЮЧЕН (поле не задано или пустая строка). Решение заказчика 08.08.2026:
   * «постоянно прибыльные сделки теряю из-за этого условия — когда немного выходим из диапазона,
   * сделка скипается». Порог 0.5% рубил вход, стоило рынку отойти от диапазона на полпроцента,
   * хотя сама сделка оставалась той же (живой случай: #ZRO/USDT SHORT, рынок ушёл на 1.6%,
   * вход пришлось доставлять руками).
   *
   * Вместо запрета — вход по ЖИВОЙ цене (resolveEntryPrice): раз ордер всё равно рыночный,
   * плечо/размер/ликвидация теперь считаются от той цены, по которой реально произойдёт филл,
   * а не от середины уже неактуального диапазона. Задать число — вернуть прежний гейт.
   */
  maxEntrySlippagePct?: string
  /**
   * Разрешён ли поход в AI (по умолчанию да).
   *
   * Нужен для ОФЛАЙН-прогонов — бэктест на исторических сообщениях: с тех пор как CH1 отдаёт
   * непонятое в AI (смена формата канала не должна терять сигналы), реплей фикстуры начал бы
   * дёргать ai-proxy по сети — то есть висеть на таймаутах и ЖЕЧЬ ПЛАТНЫЕ вызовы на каждом прогоне
   * тестов. С `false` route='ai' обрабатывается как «AI недоступен» → needs_review, ноль ордеров:
   * бэктест честно покажет такие сообщения как требующие разбора, а не притворится, что их нет.
   */
  aiEnabled?: boolean
}

// Отклонение рынка от диапазона входа, начиная с которого вход логируется отдельной строкой.
// Не гейт — именно порог наблюдаемости: 0.5% раньше означало skip, теперь означает «зашли по
// текущим, вот насколько рынок ушёл» (см. resolveEntryPrice).
const ENTRY_DRIFT_LOG_PCT = '0.5'

// «Фиксирую» без явной доли — это половина: самый частый смысл в сигналах («зафиксировал часть»,
// «скинул половину»). Если автор назвал долю («закрыл 30%»), берётся она, а не этот дефолт.
const DEFAULT_PARTIAL_CLOSE_FRACTION = '0.5'

// Типичная лесенка канала — три цели. Отсюда и доля одной ступени: «первый тейк» забирает треть
// позиции (решение заказчика 28.07.2026). Число целей, названное автором, важнее этого дефолта.
const LADDER_SLOTS = 3

// «Цель взята» без указанной доли и без нашего TP-ордера на бирже — закрываем ступень лесенки от
// ИСХОДНОГО объёма. Названная автором доля важнее — её исполняет ветка partial_close.
const DEFAULT_TP_HIT_FRACTION = new Decimal(1).div(LADDER_SLOTS)

type ChannelRow = Selectable<DB['channels']>
type ChannelSettingsRow = Selectable<DB['channel_settings']>

export async function processMessage(db: Kysely<DB>, message: PipelineMessage, deps: PipelineDeps): Promise<void> {
  let notifyNeeded = false
  // Уборка за полным закрытием — строго ПОСЛЕ коммита (см. finalizeClosedPositions: внутри
  // транзакции тот же UPDATE ловил deadlock с приватным WS).
  const postCommit: IntentBase['postCommit'] = []

  await db.transaction().execute(async (trx) => {
    const channel = await trx
      .selectFrom('channels')
      .selectAll()
      .where('id', '=', message.channelId)
      .executeTakeFirstOrThrow()
    // ИСТОРИЯ КАНАЛА НЕ РАЗБИРАЕТСЯ — самый первый гейт, ДО adapter.parse и до любого вызова AI.
    //
    // Живой инцидент (прод, 25.07.2026): новый сервер, каналы засидились с курсором 0, бэкфилл
    // вытянул всю историю (~3100 сообщений), и движок принял её за свежую: 2268 вызовов AI на
    // $22.73, а сообщение от 30 декабря 2025 открыло РЕАЛЬНУЮ позицию на mainnet. Сигнал возрастом
    // в полгода не «поздний» — он бессмысленный: цена ушла, позиция автора давно закрыта.
    //
    // Гейт стоит ЗДЕСЬ, а не в выборке `main.ts::processChannel`: фильтр в SELECT оставил бы
    // исторические строки навсегда в статусе `received`, и поллер перечитывал бы их каждые 5 секунд.
    // Ранний выход переводит их в терминальный `archived` (миграция 004 завела этот статус ровно
    // под «вне окна обработки, разбор сознательно не запускался») и публикует событие — фронт
    // снимает лоадер «Разбираем сообщение…».
    if (message.tgMessageId <= channel.process_from_message_id) {
      await trx
        .updateTable('messages')
        .set({ status: 'archived', status_reason: 'historical_backlog', updated_at: new Date() })
        .where('id', '=', message.id)
        .execute()
      await emitMessageProcessed(trx, message)
      notifyNeeded = true
      return
    }

    const settings = await trx
      .selectFrom('channel_settings')
      .selectAll()
      .where('channel_id', '=', message.channelId)
      .executeTakeFirstOrThrow()

    // ВЫКЛЮЧЕННОЕ КОПИРОВАНИЕ — второй гейт, тоже ДО разбора и до вызова AI.
    //
    // Раньше сообщение выключенного канала проходило ВЕСЬ путь (детерминированный разбор → модель
    // → реконсиляция) и только на самом исходе каждое действие получало skip_reason='copy_disabled'.
    // Разбор при этом стоил денег: инцидент 25.07.2026 — 2268 вызовов AI на $22.73 на канале, у
    // которого копирование было выключено. Решение заказчика: «если отключён копитрейдинг, лишний
    // раз ничего не обрабатывать».
    //
    // Статус `skipped` (не `archived`): сообщение живое и актуальное, его просто не берут в работу
    // по решению оператора — причина видна в status_reason. Когда тумблер включат, уже разобранные
    // так сообщения повторно не разбираются: они терминальные. Это осознанный размен — оператор
    // выключает копирование именно затем, чтобы бот не тратился на канал.
    if (settings.enabled === false) {
      await trx
        .updateTable('messages')
        .set({ status: 'skipped', status_reason: 'copy_disabled', updated_at: new Date() })
        .where('id', '=', message.id)
        .execute()
      await emitMessageProcessed(trx, message)
      notifyNeeded = true
      return
    }

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
    const aiBranch =
      parsed.route === 'ai' && deps.aiEnabled !== false
        ? await runAiBranch(trx, db, message, normalizedText, instruments, channel.adapter_id)
        : null
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
      await emitMessageProcessed(trx, message)
      notifyNeeded = true
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
      await emitMessageProcessed(trx, message)
      notifyNeeded = true
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
      await emitMessageProcessed(trx, message)
      notifyNeeded = true
      return
    }

    // decision.outcome === 'executing' — decision.method всегда 'auto' либо 'ai' (never null/'review').
    const method: 'auto' | 'ai' = decision.method === 'ai' ? 'ai' : 'auto'
    warnUncoveredSymbols(message, decision.decided, ctx)
    const base: IntentBase = { message, channel, settings, instruments, deps, postCommit }
    // Гейт "Copy trading" сюда уже НЕ доходит: выключенный канал отсекается в самом начале
    // processMessage, до разбора и до вызова AI (см. там же — почему).
    for (const { actionIndex, intent } of decision.decided) {
      const emitted = await processIntent(trx, base, actionIndex, intent, method)
      if (emitted) notifyNeeded = true
    }

    await trx
      .updateTable('messages')
      .set({ status: 'executed', normalized_text: normalizedText, method, ai_summary: aiSummary, updated_at: now })
      .where('id', '=', message.id)
      .execute()
    await emitMessageProcessed(trx, message)
    notifyNeeded = true
  })

  if (postCommit.length > 0) {
    const finalized = await finalizeClosedPositions(db, message.channelId, postCommit, deps)
    notifyNeeded = notifyNeeded || finalized
  }

  if (notifyNeeded) {
    await sql`SELECT pg_notify('domain_events', '')`.execute(db)
  }
}

/**
 * ЛУПА НА ПОТЕРЯННЫЕ ИНСТРУКЦИИ. Сообщение разобралось и что-то исполняет, но в его тексте
 * упомянута ЕЩЁ ОДНА торгуемая монета, по которой не появилось ни одного действия — ни
 * executed, ни skipped. Именно так пропал XRP из msg 221563 (06.08.2026): правило B вернуло две
 * лимитки и остановило разбор, строка «С текущих long Xrp» не дала вообще ничего, и в UI не было
 * даже следа, что бот её видел. Такой провал не находится ни по одной таблице — только глазами
 * по тексту, поэтому он должен кричать в лог сам.
 *
 * Предупреждение мягкое: монета может упоминаться и справочно («биток тянет всех вниз»). Цена
 * ложного срабатывания — строка в логе, цена пропущенного — не открытая позиция.
 */
function warnUncoveredSymbols(message: PipelineMessage, decided: ReadonlyArray<{ intent: ParsedIntent }>, ctx: ParseContext): void {
  const covered = new Set(decided.map(({ intent }) => ('symbol' in intent ? intent.symbol : null)).filter((s): s is string => s !== null))
  const uncovered = new Map<string, string>()
  for (const line of message.text.split('\n')) {
    if (line.trim().length === 0) continue
    for (const coin of extractCoins(line)) {
      const symbol = ctx.resolveSymbol(coin)
      if (symbol === null || !ctx.isListed(symbol) || covered.has(symbol) || uncovered.has(symbol)) continue
      uncovered.set(symbol, line.trim())
    }
  }
  if (uncovered.size === 0) return
  for (const [symbol, line] of uncovered) {
    console.warn(
      `[pipeline] msg ${message.tgMessageId} (канал ${message.channelId}): по ${symbol} НЕТ действий, ` +
        `хотя монета упомянута в строке «${line}» — проверьте правила адаптера`,
    )
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
        // Ветка реплаев целиком: символ терсной реплики («3🎯») лежит в корне ветки, а не у
        // прямого родителя (живой случай 09.08.2026 — тейк по SOL уехал на BTC).
        ...(aiContext.replyChain !== undefined ? { replyChain: aiContext.replyChain } : {}),
        ...(aiContext.replyChainSymbol !== undefined ? { replyChainSymbol: aiContext.replyChainSymbol } : {}),
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

/**
 * ЦЕПОЧКА РЕПЛАЕВ, А НЕ ОДИН РОДИТЕЛЬ.
 *
 * Автор ведёт сделку короткими репликами в ответ на предыдущую: «Sol 1🎯» ← «2🎯» ← «3🎯».
 * Символ назван ОДИН раз, в начале ветки, а дальше каждое сообщение отвечает такой же терсной
 * реплике без символа. Раньше контекст знал ровно одного родителя — и на втором таком хопе символ
 * терялся: живой случай 09.08.2026 (msg 221572 «3🎯») разобрался как тейк по BTC, потому что
 * ближайшим «понятным» символом оказалась свежая заявка по битку, а не солана из корня ветки.
 *
 * Поднимаемся вверх до REPLY_CHAIN_MAX_HOPS сообщений. Ограничение — не экономия запросов
 * (их считанные единицы), а смысл: чем дальше предок, тем слабее его связь с текущей репликой.
 * `seen` — защита от цикла (сообщение-ответ само на себя в кривых данных повесило бы движок).
 */
const REPLY_CHAIN_MAX_HOPS = 6

type ReplyChainRow = {
  tg_message_id: number
  text: string
  msg_ts: Date
  reply_to_msg_id: number | null
  grouped_id: string | null
  media_kind: string | null
}

async function loadReplyChain(
  trx: Kysely<DB>,
  channelId: number,
  startId: number | null,
): Promise<Map<number, ReplyChainRow>> {
  const chain = new Map<number, ReplyChainRow>()
  let currentId = startId
  for (let hop = 0; currentId !== null && hop < REPLY_CHAIN_MAX_HOPS; hop++) {
    if (chain.has(currentId)) break // цикл
    // tg_message_id уникален ТОЛЬКО в паре с channel_id — фильтр по каналу обязателен.
    const row = await trx
      .selectFrom('messages')
      .select(['tg_message_id', 'text', 'msg_ts', 'reply_to_msg_id', 'grouped_id', 'media_kind'])
      .where('channel_id', '=', channelId)
      .where('tg_message_id', '=', currentId)
      .executeTakeFirst()
    if (!row) break
    chain.set(row.tg_message_id, row)
    currentId = row.reply_to_msg_id
  }
  return chain
}

async function buildParseContext(trx: Kysely<DB>, message: PipelineMessage, instruments: InstrumentMap): Promise<ParseContext> {
  const replyChain = await loadReplyChain(trx, message.channelId, message.replyToMsgId)

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
    // Отдаёт ЛЮБОЕ сообщение из цепочки реплаев, а не только прямого родителя: терсная реплика
    // («3🎯») сплошь и рядом отвечает такой же терсной реплике, и символ лежит на два-три хопа
    // выше (см. loadReplyChain).
    getMessage: (id: number) => {
      const row = replyChain.get(id)
      return row === undefined
        ? null
        : toParseContextMessage({
            tgMessageId: row.tg_message_id,
            text: row.text,
            msgTs: row.msg_ts,
            replyToMsgId: row.reply_to_msg_id,
            groupedId: row.grouped_id,
            mediaKind: row.media_kind,
          })
    },
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
  /**
   * Что сделать ПОСЛЕ коммита транзакции сообщения. Сюда попадают символы, которые это сообщение
   * закрыло целиком: обнулить зеркало позиции и снять висящие reduceOnly-остатки (R8).
   *
   * Почему не внутри транзакции (найдено живым прогоном): `UPDATE positions` в транзакции
   * пайплайна, который к тому моменту уже держит блокировки на trades/symbol_ownership, встречно
   * блокируется с транзакцией приватного WS (та берёт positions ПЕРВОЙ, а trades — следом).
   * Postgres честно поймал это как `deadlock detected` и откатил сообщение целиком — при том, что
   * ордер на биржу уже ушёл. Одиночный UPDATE после коммита держит РОВНО ОДНУ блокировку и
   * взаимно заблокироваться не может; сеть (cancelAll) там же — по общему правилу «сеть не держит
   * транзакцию БД».
   */
  postCommit: Array<{ symbol: string; tradeId: string }>
}

interface HandlerResult {
  skipReason?: string
  tradeId?: string
  side?: Side
  symbol?: string
  /**
   * Действие оказалось не тем, чем выглядело в тексте: «Limit long Eth 1895» по УЖЕ открытому
   * эфиру — это доливка, а не новый вход (см. resolveBusySymbol). Тип строки actions переписываем
   * на фактический, иначе в UI и в журнале останется 'open' у ордера с purpose='add'.
   */
  rewrittenType?: 'add'
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
 * @returns true, если был опубликован хотя бы один domain_events (нужно ли слать pg_notify).
 */
async function processIntent(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  intent: ParsedIntent,
  method: 'auto' | 'ai',
): Promise<boolean> {
  const info = classifyIntent(intent)

  // ИДЕМПОТЕНТНОСТЬ ПО СМЫСЛУ, А НЕ ПО ПОРЯДКУ. Раньше ключом был (сообщение, индекс действия),
  // и этого хватало, пока сообщение разбиралось ровно один раз. Но правка сообщения возвращает
  // его в очередь (repository.ts::saveMessage), а разбор изменённого текста может дать другое
  // число интентов и другой их порядок — по индексу мы бы либо пропустили НОВУЮ инструкцию
  // (её слот занят), либо исполнили повторно УЖЕ сделанную (она уехала на другой индекс).
  //
  // Поэтому ключ — (сообщение, тип действия, символ): «поставить стоп по BTC» из этого сообщения
  // исполняется один раз, сколько бы раз его ни переразбирали, а дописанная строкой новая
  // инструкция («первый тейк по битку») видится как новая и исполняется.
  const existing = await trx
    .selectFrom('actions')
    .select('id')
    .where('message_id', '=', base.message.id)
    .where((eb) =>
      eb.or([
        eb('action_index', '=', actionIndex),
        eb.and([eb('type', '=', info.type), info.symbol === null ? eb('symbol', 'is', null) : eb('symbol', '=', info.symbol)]),
      ]),
    )
    .executeTakeFirst()
  if (existing) return false
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
  switch (intent.kind) {
    case 'entry_signal':
      result = await handleOpen(trx, base, actionIndex, actionId, specFromEntrySignal(intent))
      break
    // «Long BTC, с текущих» — вход по рынку. Цены и стопа в сигнале нет: цену берём с рынка,
    // стоп синтезируем защитный (см. handleOpen). Самый частый способ дать сигнал в свободном
    // тексте — до этого он молча уходил в skip и НЕ торговался вовсе.
    case 'market_entry': {
      const spec = await specFromMarketEntry(base, intent)
      result = 'skipReason' in spec ? spec : await handleOpen(trx, base, actionIndex, actionId, spec)
      break
    }
    // «зайду от 76.3» — лимитный вход по названной цене.
    case 'limit_entry':
      result = await handleOpen(trx, base, actionIndex, actionId, specFromLimitEntry(intent))
      break
    case 'add':
      result = await handleAdd(trx, base, actionIndex, actionId, intent)
      break
    case 'delta':
      result = await handleDelta(trx, base, actionIndex, actionId, intent)
      break
  }

  const now = new Date()
  if (result.skipReason) {
    // Пропуск действия — единственный исход, который НИЧЕГО не делает с деньгами, и потому
    // единственный, который легко не заметить. Пишем его в лог всегда и с координатами
    // сообщения: разбор живых жалоб «почему бот проигнорировал сигнал» начинается именно отсюда.
    console.warn(
      `[pipeline] msg ${base.message.tgMessageId} (канал ${base.message.channelId}) SKIP ` +
        `${info.type} ${info.symbol ?? '—'} ${info.side ?? ''} → ${result.skipReason}`,
    )
    await trx
      .updateTable('actions')
      .set({
        status: 'skipped',
        skip_reason: result.skipReason,
        ...(result.rewrittenType !== undefined ? { type: result.rewrittenType } : {}),
        updated_at: now,
      })
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
    .set({
      trade_id: result.tradeId ?? null,
      side: finalSide,
      status: 'executed',
      ...(result.rewrittenType !== undefined ? { type: result.rewrittenType } : {}),
      executed_at: now,
      updated_at: now,
    })
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

/**
 * «Разбор сообщения закончен» — сигнал фронту обновить узел таймлайна.
 *
 * ЗАЧЕМ. Сообщение прилетает в UI по WS от tg-ingest СРАЗУ (status='received'), а действия и
 * AI-саммари появляются позже — их дописывает движок. Событий о самих действиях (action.new/
 * action.skipped) для таймлайна недостаточно: их payload узкий и не содержит собранный узел
 * (альбом, медиа, текст), а у noise-сообщений действий нет вовсе — и узел так и остался бы «пустым»
 * до перезагрузки страницы. Поэтому шлём одно событие на сообщение, а api (outbox.publisher.ts)
 * пересобирает по нему актуальный MessageDto и рассылает 'message.updated' — фронт уже умеет
 * заменять узел на месте.
 *
 * Публикуется В ТОЙ ЖЕ транзакции, что и финальный статус сообщения (outbox-паттерн): иначе крэш
 * между коммитом статуса и вставкой события оставил бы UI навсегда с крутящимся лоадером.
 */
async function emitMessageProcessed(trx: Kysely<DB>, message: PipelineMessage): Promise<void> {
  await trx
    .insertInto('domain_events')
    .values({
      type: 'message.processed',
      aggregate: 'message',
      aggregate_id: message.id,
      payload: JSON.stringify({ channelId: message.channelId, messageId: message.id }),
    })
    .execute()
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

/**
 * Прибирает за НАШИМ ЖЕ полным закрытием — ПОСЛЕ коммита транзакции сообщения:
 *   1) зануляет зеркало позиции;
 *   2) снимает висящие reduceOnly-остатки символа (R8).
 *
 * Зачем (1), если есть приватный WS: живой e2e показал, что финальный пуш `position size=0`
 * иногда до зеркала не доходит (3 прогона из 5) — и строка `positions` навсегда остаётся с
 * размером до закрытия. Оператор видит в UI фантомную открытую позицию, а handleDelta (он ищет
 * сделку ровно по `positions.size <> 0`) начинает «управлять» несуществующей позицией.
 *
 * Зачем (2): раньше cancel-all делал именно обработчик flat-пуша (private-ws.ts, R8). Обнулив
 * зеркало сами, мы лишаем его последней зацепки для атрибуции символа — и висящие TP снимались бы
 * только реконсиляцией, то есть до 10 минут. Здесь мы знаем правду детерминированно и снимаем их
 * сразу; повторный cancel-all со стороны WS безвреден (идемпотентен).
 *
 * Ошибки не пробрасываются: сообщение уже закоммичено и переигрывать его нельзя (ордер ушёл).
 * Любой сбой этой уборки лечится периодической реконсиляцией (шаг Б2 и шаг Г).
 */
async function finalizeClosedPositions(
  db: Kysely<DB>,
  channelId: number,
  closed: ReadonlyArray<{ symbol: string; tradeId: string }>,
  deps: PipelineDeps,
): Promise<boolean> {
  let notifyNeeded = false
  for (const { symbol, tradeId } of closed) {
    try {
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('positions')
          .set({ size: '0', updated_at: new Date() })
          .where('channel_id', '=', channelId)
          .where('symbol', '=', symbol)
          .where('trade_id', '=', tradeId)
          .where(sql<boolean>`size <> 0`)
          .returning('symbol')
          .executeTakeFirst()
        if (!updated) return
        await emitPositionUpsert(trx, channelId, symbol)
        notifyNeeded = true
      })
    } catch (err) {
      console.error(`[pipeline] не удалось обнулить зеркало ${symbol} после закрытия:`, err)
    }

    try {
      await deps.executionPort.cancelAllForSymbol(symbol)
    } catch (err) {
      console.error(`[pipeline] не удалось снять остатки ордеров по ${symbol} после закрытия:`, err)
    }
  }
  return notifyNeeded
}

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
/**
 * `tps` — цели ВМЕСТЕ С ИХ НОМЕРАМИ В СИГНАЛЕ, а не просто список цен. Номер уезжает в
 * orders.tp_index и в orderLinkId, а по нему потом ищутся ступени («первая цель», «вторая»):
 * если рынок уже прошёл первую цель и она из лесенки выпала, оставшиеся обязаны сохранить свои
 * исходные номера (1 и 2), иначе «вторую цель» автора мы применили бы к чужой ступени.
 */
function buildTpTargets(
  total: Decimal,
  tps: readonly { price: number; index: number }[],
  qtyStep: string,
): { price: string; qty: string; index: number }[] {
  const n = tps.length
  if (n === 0) return []

  const qtys = splitQtyEvenly(total, n, qtyStep)
  const nonZero = tps
    .map((tp, position) => ({ price: tp.price.toString(), qty: (qtys[position] ?? new Decimal(0)).toString(), index: tp.index }))
    .filter((t) => !new Decimal(t.qty).isZero())
  if (nonZero.length > 0) return nonZero

  const last = tps[n - 1]
  if (last === undefined) return [] // n===0 уже отсечено выше — сюда не попасть, defensive

  console.warn(
    `[pipeline] TP-лесенка из ${n} целей схлопнута в один TP: qty=${total.toString()} < qtyStep=${qtyStep} · ${n} — ` +
      `равными долями раздать нечего, весь объём уходит в последнюю цель (${last.price}).`,
  )
  return [{ price: last.price.toString(), qty: total.toString(), index: last.index }]
}

/**
 * Доли TP-лесенки для op `tp_set` — то есть для целей, которые автор называет УЖЕ ПОСЛЕ входа.
 *
 * Отличие от лесенки входа (buildTpTargets выше) принципиальное и денежное. На входе автор
 * перечисляет ВЕСЬ набор целей разом, и делить между ними весь объём правильно. А в сообщении
 * «Первый тейк по эфиру - 1943» цель названа ОДНА из подразумеваемых трёх — прежний код делил
 * объём «поровну на одну цель» и ставил тейк на ВСЮ позицию (живой случай 28.07.2026: XRP получил
 * тейк на 188.6 из 188.6 вместо трети).
 *
 * Размер ступени: доля, названная автором для этой цели → иначе 1/N, где N — названное автором
 * число целей либо `max(целей в сообщении, LADDER_SLOTS)`. То есть три названные разом цели
 * по-прежнему делят объём поровну, а одна названная — забирает треть.
 *
 * Базис — ИСХОДНЫЙ объём сделки (ступени лесенки считаются от него, а не от остатка), но сумма
 * ступеней ограничена реальным остатком: нельзя выставить на продажу больше, чем есть.
 */
function buildLadderTargets(params: {
  basis: Decimal
  remaining: Decimal
  targets: ReadonlyArray<{ price: Decimal; index?: number; fraction?: number; qty?: Decimal }>
  ladderTotal?: number
  qtyStep: string
}): { price: string; qty: string; index: number }[] {
  const n = params.targets.length
  if (n === 0 || params.remaining.lte(0)) return []

  const slots = params.ladderTotal !== undefined && params.ladderTotal > 0 ? params.ladderTotal : Math.max(n, LADDER_SLOTS)

  let left = params.remaining
  const built: { price: string; qty: string; index: number }[] = []
  for (const [i, target] of params.targets.entries()) {
    // Делим базис на число ступеней, а НЕ умножаем на долю 1/N: 1/3 в Decimal — это 0.333…3, и
    // три такие ступени не сложились бы обратно в объём (3 × 0.33…3 = 0.99…9 → потеря шага).
    // Приоритет размера: готовый объём («скину доливку» — объём леги посчитал пайплайн) →
    // явная доля автора («на первой фикс 30%») → равная ступень лесенки.
    const stepQty = target.qty ?? (target.fraction !== undefined ? params.basis.mul(target.fraction) : params.basis.div(slots))
    // Ступень не может превысить остаток — и следующая ступень считает уже от того, что осталось.
    const qty = Decimal.min(floorTo(params.qtyStep, stepQty), left)
    if (qty.lte(0)) continue // ступень меньше шага объёма — молча пропускаем эту цель
    built.push({ price: target.price.toString(), qty: qty.toString(), index: target.index ?? i })
    left = left.minus(qty)
  }
  // Здесь НЕТ фолбэка «весь объём в последнюю цель» (он есть у лесенки входа): для названной
  // ступени это означало бы ровно тот дефект, который мы чиним — тейк на всю позицию.
  return built
}

/**
 * Нормализованное описание ЛЮБОГО открытия позиции — общий вход для трёх типов сигналов:
 *
 *   entry_signal  «#SOL/USDT LONG, вход 76.3-76.5, TP 80, SL 72»  → всё есть в сигнале
 *   market_entry  «Long BTC, с текущих»                            → нет ни цены, ни стопа
 *   limit_entry   «зайду от 76.3»                                  → есть цена, нет стопа
 *
 * Раньше исполнялся только первый: два других уходили в skip('not_implemented_phase1') — свободный
 * текст («беру с текущих» — самый частый способ сказать «покупаю») не торговался вообще.
 * Сводим их в одну структуру, чтобы не копировать 150 строк гейтов/сайзинга трижды.
 */
interface OpenSpec {
  symbol: string
  side: Side
  orderType: 'market' | 'limit'
  /** market → живой mark; limit → цена из сигнала; диапазон → его середина. */
  entryPrice: Decimal
  /** Стоп ИЗ СИГНАЛА. Нет — синтезируем защитный из плеча (см. protective-sl.ts). */
  signalSl?: Decimal
  /**
   * Цена входа взята ИЗ СИГНАЛА (а не с рынка) — только тогда осмыслен гейт слиппеджа: сигнал мог
   * протухнуть, пока шёл до нас. У market_entry цена и ЕСТЬ текущий mark (отклонение ≡ 0), у лимитки
   * цена намеренно стоит вне рынка — там гейт не защищает, а просто зарубил бы вход.
   */
  priceFromSignal: boolean
  tps: number[]
  /** Риск автора. Учитывается ТОЛЬКО вместе с авторским стопом — см. handleOpen. */
  riskPct?: number
}

function specFromEntrySignal(intent: Extract<ParsedIntent, { kind: 'entry_signal' }>): OpenSpec {
  // Вход диапазоном — берём середину как цену симулированного market-филла (research: «entry для
  // лимитки — цена лимитки, для market — текущая цена»).
  const entryPrice = Array.isArray(intent.entry)
    ? new Decimal(intent.entry[0]).plus(intent.entry[1]).div(2)
    : new Decimal(intent.entry)

  return {
    symbol: intent.symbol,
    side: intent.side,
    orderType: 'market',
    entryPrice,
    priceFromSignal: true,
    signalSl: new Decimal(intent.sl),
    tps: intent.tps,
    ...(intent.riskPct !== undefined ? { riskPct: intent.riskPct } : {}),
  }
}

function specFromLimitEntry(intent: Extract<ParsedIntent, { kind: 'limit_entry' }>): OpenSpec {
  return {
    symbol: intent.symbol,
    side: intent.side,
    orderType: 'limit',
    entryPrice: new Decimal(intent.price),
    priceFromSignal: true,
    ...(intent.sl !== undefined ? { signalSl: new Decimal(intent.sl) } : {}),
    tps: intent.tps ?? [],
    ...(intent.riskPct !== undefined ? { riskPct: intent.riskPct } : {}),
  }
}

/**
 * market_entry: цены в сигнале нет вовсе — берём ЖИВОЙ mark. `null` (нет источника цены или сбой
 * похода за ней) — fail-CLOSED: торговая система не входит вслепую, если не знает текущую цену.
 */
async function specFromMarketEntry(
  base: IntentBase,
  intent: Extract<ParsedIntent, { kind: 'market_entry' }>,
): Promise<OpenSpec | { skipReason: string }> {
  if (!base.deps.getMarkPrice) return { skipReason: 'mark_price_unavailable' }
  const mark = await base.deps.getMarkPrice(intent.symbol)
  if (mark === null) return { skipReason: 'mark_price_unavailable' }

  return {
    symbol: intent.symbol,
    side: intent.side,
    orderType: 'market',
    entryPrice: new Decimal(mark),
    priceFromSignal: false, // цена = живой mark, отклоняться ей не от чего
    ...(intent.sl !== undefined ? { signalSl: new Decimal(intent.sl) } : {}),
    tps: intent.tps ?? [],
    ...(intent.riskPct !== undefined ? { riskPct: intent.riskPct } : {}),
  }
}

/**
 * Базис TP-лесенки — САМЫЙ БОЛЬШОЙ объём, которым сделка когда-либо была: вход плюс исполненные
 * доливки, но не меньше текущей позиции.
 *
 * Раньше базисом был `trades.initial_size` — размер ПЕРВОГО входа. После доливки лесенка считалась
 * от него и покрывала позицию лишь частично: живой случай 11.08.2026 — XRP, вход 479.7 + доливка
 * 495, «первый таргет» встал на 159.9 (треть первого входа), то есть на 16% реальной позиции.
 *
 * Почему именно максимум из двух величин:
 *  - сумма ИСПОЛНЕННЫХ лег — то, что автор в сделку реально вложил; ещё не сработавшая лимитная
 *    доливка в неё не входит (позиции такого объёма пока нет, и обещать её выход нельзя);
 *  - текущий размер позиции страхует случай, когда филлы в журнал не доехали (догон истории,
 *    ручной вход оператора) — базис не должен оказаться меньше того, что реально висит на бирже;
 *  - остаток базисом быть не может: после фиксации части ступени схлопывались бы каждый раз
 *    заново («первая цель» после закрытия половины давала бы уже шестую часть, а не треть).
 */
async function resolveLadderBasis(trx: Kysely<DB>, tradeId: string, positionSize: Decimal): Promise<Decimal> {
  const { rows } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(COALESCE(filled_qty, 0)), 0)::text AS total
    FROM trade_legs
    WHERE trade_id = ${tradeId}::uuid AND kind IN ('entry', 'add')
  `.execute(trx)
  return Decimal.max(new Decimal(rows[0]?.total ?? 0), positionSize)
}

/**
 * Объём ОДНОЙ доливки сделки — «скину доливку», «закрыл один объём».
 *
 * Автор мыслит легами, а не процентами: доливка была на свою сумму, и выходить из неё он собирается
 * целиком. Берём ПОСЛЕДНЮЮ исполненную лег-доливку (kind='add'): именно про неё говорят «доливка»,
 * когда их было несколько. Доливок нет вовсе — null, вызывающий код решает, что делать дальше.
 */
async function resolveOneUnitQty(trx: Kysely<DB>, tradeId: string): Promise<Decimal | null> {
  // Источник правды — ИСПОЛНЕННЫЙ ордер доливки, а не строка trade_legs: у лег filled_qty
  // проставляет только handleOpen для входа, а долившийся лимитник ногу не трогает вовсе (живой
  // XRP 11.08.2026: ордер add на 495 filled, а лега так и осталась pending с filled_qty=0).
  const order = await trx
    .selectFrom('orders')
    .select('qty')
    .where('trade_id', '=', tradeId)
    .where('purpose', '=', 'add')
    .where('status', '=', 'filled')
    .orderBy('filled_at', 'desc')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  if (order?.qty != null && new Decimal(order.qty).gt(0)) return new Decimal(order.qty)

  // Фолбэк — лега: dry-run/бэктест и исторические сделки, где ордера доливки в журнал не попали.
  const leg = await trx
    .selectFrom('trade_legs')
    .select(['filled_qty', 'requested_qty'])
    .where('trade_id', '=', tradeId)
    .where('kind', '=', 'add')
    .orderBy('leg_index', 'desc')
    .executeTakeFirst()
  const legQty = new Decimal(leg?.filled_qty ?? 0)
  return legQty.gt(0) ? legQty : null
}

/**
 * ЦЕНА ВХОДА: У РЫНОЧНОГО ОРДЕРА — ЖИВАЯ, А НЕ ИЗ СИГНАЛА.
 *
 * Сигнал даёт диапазон входа («Диапазон входа: 0.8458-0.8245»), и раньше от его середины
 * считалось ВСЁ: плечо (из авторского стопа), размер, цена ликвидации, запись в журнал. При этом
 * ордер уходил рыночный — то есть реальный филл происходил по рынку, а математика оставалась на
 * цене, которой на рынке уже нет. Расхождение затыкал гейт: рынок отошёл больше чем на 0.5% —
 * skip('price_slippage').
 *
 * Заказчик 08.08.2026: «постоянно прибыльные сделки теряю из-за этого условия — когда немного
 * выходим из диапазона, сделка скипается. Отключи пока проверку». Гейт стал опциональным
 * (deps.maxEntrySlippagePct — задан числом, значит включён), а цена входа берётся живая: то же
 * самое, что делает market_entry («с текущих»), только стоп и цели остаются авторскими.
 *
 * Следствия, которые важнее самого отключения:
 *  - плечо считается от РЕАЛЬНОЙ дистанции до авторского стопа (рынок ближе к стопу — плечо выше,
 *    но убыток по стопу по-прежнему ограничен маржой сделки: trade_size · lev · d ≤ trade_size);
 *  - если рынок ушёл ЗА стоп, вход отсекут прежние гейты invalid_sl_side/unsafe_stop;
 *  - цели, которые рынок уже прошёл, из лесенки выбрасываются (см. handleOpen), а если пройдены
 *    все — вход не открывается вовсе (targets_passed).
 *
 * `getMarkPrice` не подключён (dry_run/бэктест — там нет сети) — остаёмся на цене сигнала, как и
 * раньше. Подключён, но вернул null (сбой похода за ценой) — fail-CLOSED: торговая система не
 * входит вслепую, если не знает текущую цену (фикс p3-slippage-fix, найден e2e).
 */
async function resolveEntryPrice(base: IntentBase, intent: OpenSpec): Promise<{ entryPrice: Decimal } | { skipReason: string }> {
  // Лимитка стоит вне рынка по определению — её цену назначил автор, подменять нечем.
  // market_entry («с текущих») уже пришёл с живым mark (specFromMarketEntry) — второй поход лишний.
  if (!intent.priceFromSignal || intent.orderType !== 'market' || !base.deps.getMarkPrice) {
    return { entryPrice: intent.entryPrice }
  }

  const currentMark = await base.deps.getMarkPrice(intent.symbol)
  if (currentMark === null) return { skipReason: 'mark_price_unavailable' }
  const mark = new Decimal(currentMark)
  const driftPct = mark.minus(intent.entryPrice).abs().div(intent.entryPrice).mul(100)

  const threshold = base.deps.maxEntrySlippagePct
  if (threshold !== undefined && threshold !== '' && threshold !== 'off' && driftPct.gt(threshold)) {
    // Гейт включён явно — прежнее поведение: сигнал считается протухшим, вход не открываем.
    return { skipReason: 'price_slippage' }
  }

  if (driftPct.gt(ENTRY_DRIFT_LOG_PCT)) {
    console.log(
      `[pipeline] msg ${base.message.tgMessageId} ${intent.symbol}: вход по текущим — сигнальная цена ` +
        `${intent.entryPrice.toString()}, рынок ${mark.toString()} (отклонение ${driftPct.toFixed(2)}%)`,
    )
  }
  return { entryPrice: mark }
}

/**
 * ЧТО ДЕЛАТЬ С НОВЫМ ВХОДОМ ПО ЗАНЯТОМУ СИМВОЛУ.
 *
 * Владение символом внутри канала (symbol_ownership) задумано как защита от ДУБЛЯ: повторно
 * присланный тот же сигнал не должен удваивать позицию (e2e-сценарий ch1-busy). Но «занят» —
 * это три РАЗНЫХ состояния, а обрабатывались они одинаково, через skip(symbol_busy):
 *
 *   1) позиция реально открыта — дубль рыночного входа, скипаем (как и раньше);
 *   2) висит НЕИСПОЛНЕННАЯ лимитка автора, а он прислал новую цену — он ПЕРЕСТАВИЛ заявку,
 *      скипать её значит не войти вовсе (живой случай 06.08.2026: msg 221563, «Limit long Eth
 *      - 1895» при висящей лимитке 1823 ушёл в skip, вход по эфиру потерян);
 *   3) сделка-«призрак»: лимитка отменена/сделка давно без ордеров и без позиции, а владение
 *      осталось — символ был бы заблокирован для канала НАВСЕГДА.
 *
 * Разбираем их по РЕАЛЬНОЙ экспозиции (позиция + живые ордера), а не по строке trades.status:
 * она ставится оптимистично в момент отправки лимитки и живой позиции ещё не означает.
 */
type BusyVerdict =
  | { kind: 'skip'; reason: string }
  | { kind: 'add' }
  | { kind: 'takeover'; tradeId: string | null; note: string }

async function resolveBusySymbol(
  trx: Kysely<DB>,
  base: IntentBase,
  intent: OpenSpec,
  tradeId: string | null,
): Promise<BusyVerdict> {
  // Владение без сделки — заведомый мусор (в норме недостижимо: acquireSymbol всегда пишет trade_id).
  if (tradeId === null) return { kind: 'takeover', tradeId: null, note: 'владение без сделки' }

  const trade = await trx
    .selectFrom('trades')
    .select(['id', 'side', 'status', 'manual_override'])
    .where('id', '=', tradeId)
    .executeTakeFirst()
  if (!trade) return { kind: 'takeover', tradeId, note: 'сделка не найдена' }

  // Оператор ведёт сделку руками — не вмешиваемся ни доливкой, ни отменой его ордеров.
  if (trade.manual_override) return { kind: 'skip', reason: 'manual_override' }

  // Разворот (был лонг — пришёл шорт) это НЕ вход поверх: сначала надо закрыть текущую позицию,
  // а такого указания в сигнале нет. Отдельная причина вместо symbol_busy — чтобы в UI было
  // видно, что это конфликт направления, а не дубль.
  if (trade.side !== null && trade.side !== intent.side) return { kind: 'skip', reason: 'side_conflict' }

  const position = await trx
    .selectFrom('positions')
    .select('size')
    .where('channel_id', '=', base.message.channelId)
    .where('symbol', '=', intent.symbol)
    .where(sql<boolean>`size <> 0`)
    .executeTakeFirst()

  const entryOrders = await trx
    .selectFrom('orders')
    .select(['order_link_id', 'status', 'price'])
    .where('trade_id', '=', tradeId)
    .where('purpose', 'in', ['entry', 'add'])
    .execute()
  const live = entryOrders.filter((o) => o.status === 'created' || o.status === 'pending_submit' || o.status === 'submitted')
  const filled = entryOrders.some((o) => o.status === 'filled' || o.status === 'partially_filled')

  // Та же цена, что у уже стоящего входа — это ПЕРЕСЫЛКА/повтор того же сигнала, а не новая
  // заявка. Единственный признак, отличающий их друг от друга, — цена.
  const samePrice =
    intent.orderType === 'limit' && live.some((o) => o.price !== null && new Decimal(o.price).eq(intent.entryPrice))
  if (samePrice) return { kind: 'skip', reason: 'duplicate_entry' }

  if (position !== undefined || filled) {
    // Позиция живая. Новая ЛИМИТКА по ней — ступень лесенки входа («доливка лимиткой» в лексике
    // автора), рыночный же повтор по-прежнему считаем дублем: отличить «войди ещё раз прямо
    // сейчас» от пересланного старого сигнала нечем, а удвоение позиции стоит дороже пропуска.
    if (intent.orderType === 'limit') return { kind: 'add' }
    return { kind: 'skip', reason: 'symbol_busy' }
  }

  return live.length > 0
    ? { kind: 'takeover', tradeId, note: `автор переставил вход: ${live.map((o) => o.price ?? '?').join(', ')} → ${intent.entryPrice.toString()}` }
    : { kind: 'takeover', tradeId, note: 'сделка без позиции и без живых ордеров' }
}

/**
 * Снимает остатки не состоявшейся сделки и освобождает символ: висящие ордера (неисполненный
 * вход и его защитный стоп) отменяются на бирже, сделка помечается 'cancelled'.
 *
 * Статус именно 'cancelled', а не 'closed': позиции не было, результата у неё нет — в статистику
 * канала (winRate) она входить не должна (см. closeTrade).
 */
async function releaseStaleTrade(trx: Kysely<DB>, base: IntentBase, tradeId: string | null, symbol: string): Promise<void> {
  if (tradeId === null) {
    await releaseSymbol(trx, { channelId: base.message.channelId, symbol })
    return
  }

  const liveOrders = await trx
    .selectFrom('orders')
    .select(['order_link_id', 'purpose'])
    .where('trade_id', '=', tradeId)
    .where('status', 'in', ['created', 'pending_submit', 'submitted'])
    .execute()
  for (const order of liveOrders) {
    await base.deps.executionPort.cancelOrder(trx, { orderLinkId: order.order_link_id })
  }
  await closeTrade(trx, { tradeId, status: 'cancelled' })
  // closeTrade освобождает владение по trade_id; повтор по (канал, символ) — страховка на случай
  // рассинхрона строки symbol_ownership со сделкой (иначе новый вход тут же упрётся в acquireSymbol).
  await releaseSymbol(trx, { channelId: base.message.channelId, symbol })
  console.log(
    `[pipeline] ${symbol}: сделка ${tradeId} без позиции закрыта как cancelled, ` +
      `снято ордеров: ${liveOrders.length} (${liveOrders.map((o) => o.purpose).join(', ') || '—'}), символ освобождён`,
  )
}

async function handleOpen(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  actionId: string,
  intent: OpenSpec,
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
    .select(['id', 'trade_id'])
    .where('channel_id', '=', base.message.channelId)
    .where('symbol', '=', intent.symbol)
    .where('released_at', 'is', null)
    .executeTakeFirst()
  if (busy) {
    const verdict = await resolveBusySymbol(trx, base, intent, busy.trade_id)
    console.log(
      `[pipeline] msg ${base.message.tgMessageId} ${intent.symbol}: символ занят сделкой ${busy.trade_id ?? '—'} → ${verdict.kind}` +
        ('reason' in verdict ? ` (${verdict.reason})` : '') +
        ('note' in verdict ? ` (${verdict.note})` : ''),
    )
    if (verdict.kind === 'skip') return { skipReason: verdict.reason }
    if (verdict.kind === 'add') {
      // Автор ставит НОВЫЙ вход по символу, где его позиция уже открыта, — это ступень добора,
      // а не повторный сигнал. Действие переклеиваем в 'add', чтобы в UI и в журнале оно
      // называлось тем, чем является.
      const added = await handleAdd(trx, base, actionIndex, actionId, {
        kind: 'add',
        symbol: intent.symbol,
        side: intent.side,
        ...(intent.orderType === 'limit' ? { price: intent.entryPrice.toNumber() } : {}),
      })
      return { ...added, rewrittenType: 'add' }
    }
    // takeover: прошлый вход не состоялся (лимитка висит неисполненной либо от сделки остался
    // один "призрак" владения) — снимаем его остатки и входим заново, уже по новой цене.
    await releaseStaleTrade(trx, base, verdict.tradeId, intent.symbol)
  }

  // Цена входа: у РЫНОЧНОГО ордера — живая, а не середина диапазона сигнала (см. resolveEntryPrice).
  // Decimal, а НЕ JS-float (Minor #3 адверсариального ревью, CLAUDE.md: "деньги — Decimal/строки")
  // — это единственная денежная величина ядра, которая считалась во float, до этого исправления.
  const resolved = await resolveEntryPrice(base, intent)
  if ('skipReason' in resolved) return resolved
  const entryPrice = resolved.entryPrice

  // ── Стоп: авторский, либо наш защитный ───────────────────────────────────────────────────────
  //
  // Свободный текст сплошь и рядом без стопа («Long BTC, с текущих»). Войти на плече и не поставить
  // стоп — прямой путь к ликвидации, поэтому политика no_sl_policy='attach_protective_sl' требует
  // повесить СВОЙ страховочный стоп (design spec §8). Он выводится инверсией той же формулы, что
  // считает плечо (risk/protective-sl.ts): стоп встаёт ровно там, где выбранное плечо перестаёт быть
  // безопасным — строго перед ликвидацией. Когда автор позже пришлёт свой стоп (`sl_set`), он его
  // заменит — это уже работает через handleDelta, отдельного кода не нужно.
  //
  // Связка «плечо ← стоп» здесь ИНВЕРТИРОВАНА в «стоп ← плечо»: без стопа вывести плечо из сигнала
  // нечем, поэтому его задаёт настройка канала (default_leverage), а стоп — следствие плеча.
  let sl: Decimal
  let leverage: Decimal

  if (intent.signalSl !== undefined) {
    sl = intent.signalSl
    leverage = computeLeverage({
      entry: entryPrice.toString(),
      sl: sl.toString(),
      side: intent.side,
      mmr: instrument.mmr,
      channelMaxLev: base.settings.max_leverage,
      instrMaxLev: instrument.maxLeverage,
      leverageStep: instrument.leverageStep,
    })
  } else {
    if (base.settings.no_sl_policy !== 'attach_protective_sl') {
      // Канал настроен «без стопа не входим» — уважаем.
      return { skipReason: 'no_SL' }
    }
    leverage = leverageWithoutSl({
      defaultLev: base.settings.default_leverage,
      channelMaxLev: base.settings.max_leverage,
      instrMaxLev: instrument.maxLeverage,
      leverageStep: instrument.leverageStep,
    })
    const protective = protectiveSl({ entry: entryPrice, side: intent.side, lev: leverage, mmr: instrument.mmr })
    if (protective === null) {
      // Плечо так велико, что стоп схлопнулся бы в саму цену ликвидации — «защита» была бы
      // фиктивной. Лучше не войти, чем войти без реальной защиты.
      return { skipReason: 'unsafe_leverage' }
    }
    sl = protective
  }

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

  // Цели, до которых рынок УЖЕ дошёл, в лесенку не ставим: reduceOnly-ордер по ту сторону цены
  // входа — это обещание закрыться там, где закрываться уже поздно (для лонга цель ниже входа
  // мгновенно исполнилась бы в убыток от входа, для шорта — выше). Раньше такие цели отсекались
  // побочно, гейтом слиппеджа: он просто не пускал вход, если рынок ушёл. Гейт выключен —
  // отсекаем прицельно, по каждой цели отдельно.
  const liveTps = intent.tps
    .map((price, index) => ({ price, index }))
    .filter((tp) => (intent.side === 'long' ? new Decimal(tp.price).gt(entryPrice) : new Decimal(tp.price).lt(entryPrice)))
  if (intent.tps.length > 0 && liveTps.length === 0) {
    // Пройдены ВСЕ цели — движение, ради которого давался сигнал, уже случилось. Входить в него
    // на излёте, имея из выходов только стоп, — не «немного опоздали», а другая сделка.
    console.warn(
      `[pipeline] msg ${base.message.tgMessageId} ${intent.symbol}: рынок ${entryPrice.toString()} прошёл ВСЕ цели ` +
        `сигнала (${intent.tps.join(', ')}) — вход не открываем`,
    )
    return { skipReason: 'targets_passed' }
  }
  if (liveTps.length < intent.tps.length) {
    const kept = new Set(liveTps.map((tp) => tp.index))
    console.warn(
      `[pipeline] msg ${base.message.tgMessageId} ${intent.symbol}: цели ` +
        `${intent.tps.filter((_, i) => !kept.has(i)).join(', ')} уже пройдены рынком ${entryPrice.toString()} — ` +
        `лесенка ставится на оставшиеся (${liveTps.map((tp) => tp.price).join(', ')})`,
    )
  }

  const sizeResult = computeSize({
    // Риск учитываем ТОЛЬКО вместе с авторским стопом. Без него знаменатель риск-формулы —
    // дистанция НАШЕГО защитного стопа, то есть артефакт нашего выбора плеча, а не намерение
    // автора: «риск 2%» превратился бы в размер, зависящий от настройки канала. Тогда сайзим
    // фиксированным trade_size — предсказуемо и не выдумывает за автора (решение заказчика).
    //
    // Тумблер `force_trade_size` (миграция 009) отменяет риск-формулу совсем: оператор сказал
    // «торгуй всегда ровно на мою сумму», и размер сделки перестаёт скакать от сигнала к сигналу.
    ...(!base.settings.force_trade_size && intent.riskPct !== undefined && intent.signalSl !== undefined
      ? { riskPct: intent.riskPct.toString() }
      : {}),
    equity: base.deps.equity,
    ...(base.deps.availableBalance !== undefined ? { availableBalance: base.deps.availableBalance } : {}),
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
    orderType: intent.orderType,
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

  if (liveTps.length > 0) {
    const tpTargets = buildTpTargets(sizeResult.qty, liveTps, instrument.qtyStep)
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

/**
 * Доливка к уже открытой позиции («долил соль», «добрал от 74»).
 *
 * Размер — channel_settings.add_sizing_mode (сейчас единственный режим 'trade_size': доливаем на
 * фиксированный размер канала). Плечо НЕ меняем — оно уже выбрано при открытии сделки, менять его
 * на живой позиции значит менять её риск задним числом.
 *
 * Стоп доливкой НЕ трогаем: он уже стоит на позиции (trading-stop охватывает весь объём), а средняя
 * цена входа после долива уедет — её пересчитает биржа, и реконсиляция/WS-пуш подтянут avg_entry.
 */
async function handleAdd(
  trx: Kysely<DB>,
  base: IntentBase,
  actionIndex: number,
  actionId: string,
  intent: Extract<ParsedIntent, { kind: 'add' }>,
): Promise<HandlerResult> {
  const instrument = base.instruments.get(intent.symbol)
  if (!instrument || instrument.status !== 'Trading') return { skipReason: 'symbol_not_listed' }
  if (instrument.mmr === null) return { skipReason: 'mmr_unavailable' }

  // Доливать можно только В СУЩЕСТВУЮЩУЮ позицию этого канала. Нет позиции — это не доливка, а
  // новый вход, и угадывать за автора мы не будем.
  const position = await trx
    .selectFrom('positions')
    .selectAll()
    .where('channel_id', '=', base.message.channelId)
    .where('symbol', '=', intent.symbol)
    .where(sql<boolean>`size <> 0`)
    .executeTakeFirst()
  if (!position || position.trade_id === null || position.side === null) {
    return { skipReason: 'no_open_position' }
  }

  const trade = await trx
    .selectFrom('trades')
    .select(['id', 'leverage', 'manual_override'])
    .where('id', '=', position.trade_id)
    .executeTakeFirst()
  if (!trade) return { skipReason: 'no_open_position' }

  // Оператор взял сделку в свои руки — доливка увеличила бы риск на позиции, которой он управляет
  // сам. Симметрично правилу для SL/TP (см. handleDelta). Выход из позиции при этом всегда разрешён.
  if (trade.manual_override) return { skipReason: 'manual_override' }

  // Цена: названа автором («добрал от 74») → лимитка; не названа → по рынку.
  const orderType: 'market' | 'limit' = intent.price !== undefined ? 'limit' : 'market'
  let entryPrice: Decimal
  if (intent.price !== undefined) {
    entryPrice = new Decimal(intent.price)
  } else {
    if (!base.deps.getMarkPrice) return { skipReason: 'mark_price_unavailable' }
    const mark = await base.deps.getMarkPrice(intent.symbol)
    if (mark === null) return { skipReason: 'mark_price_unavailable' } // fail-closed, как и market_entry
    entryPrice = new Decimal(mark)
  }

  const leverage = new Decimal(trade.leverage ?? base.settings.max_leverage)

  const sizeResult = computeSize({
    equity: base.deps.equity,
    ...(base.deps.availableBalance !== undefined ? { availableBalance: base.deps.availableBalance } : {}),
    tradeSize: base.settings.trade_size, // add_sizing_mode='trade_size'
    entry: entryPrice.toString(),
    sl: position.avg_price ?? entryPrice.toString(), // sl не участвует в фолбэк-ветке (нет riskPct)
    lev: leverage,
    minNotional: instrument.minNotional,
    ...(base.settings.max_symbol_notional !== null ? { maxSymbolNotional: base.settings.max_symbol_notional } : {}),
    qtyStep: instrument.qtyStep,
  })
  if ('skip' in sizeResult) return { skipReason: sizeResult.skip }

  // Следующая по счёту «нога» сделки: entry был 0, доливки идут дальше.
  const legs = await trx
    .selectFrom('trade_legs')
    .select(({ fn }) => [fn.max('leg_index').as('max_index')])
    .where('trade_id', '=', trade.id)
    .executeTakeFirst()
  const nextLegIndex = (legs?.max_index ?? 0) + 1

  const leg = await addLeg(trx, {
    tradeId: trade.id,
    legIndex: nextLegIndex,
    kind: 'add',
    sourceMessageId: base.message.id,
    sourceActionId: actionId,
    requestedQty: sizeResult.qty.toString(),
  })

  const orderCtx = buildOrderContext(base, actionIndex, actionId, trade.id, intent.symbol, position.side)
  const projectedLiq = liqPrice({ entry: entryPrice, side: position.side, lev: leverage, mmr: instrument.mmr })

  await base.deps.executionPort.placeEntry(trx, {
    ...orderCtx,
    purpose: 'add',
    orderType,
    qty: sizeResult.qty.toString(),
    price: entryPrice.toString(),
    leverage: leverage.toString(),
    legId: leg.legId,
    liqPrice: projectedLiq.toString(),
    // stopLoss НЕ передаём: он уже стоит на позиции и охватывает весь объём, включая долитый.
  })

  // Стоп после доливки прикрывает всю позицию сам (он висит на ПОЗИЦИИ), а вот цели — нет: они
  // выставлены отдельными reduce-only ордерами на прежний объём. Без пересчёта позиция после
  // добора выходит по целям лишь частично, а остаток держится до стопа — не то, чего ждёт
  // оператор (живые случаи ARB/INJ/MMT 30-31.07.2026: лесенка покрывала 7-14% позиции).
  //
  // Только для РЫНОЧНОГО добора: лимитка ещё не исполнилась, позиция не выросла, и reduce-only
  // ордера на больший объём были бы обещанием закрыть то, чего нет.
  if (orderType === 'market') {
    await rebalanceTpLadder(trx, base, orderCtx, {
      tradeId: trade.id,
      oldSize: new Decimal(position.size),
      addedQty: sizeResult.qty,
      qtyStep: instrument.qtyStep,
    })
  }

  return {}
}

/**
 * Подтягивает уже стоящую TP-лесенку под новый объём позиции: каждая ступень сохраняет свою ДОЛЮ
 * покрытия, цены не меняются. Лесенка покрывала весь объём — покроет и новый; покрывала треть —
 * останется третью.
 *
 * Ничего не делает, если целей нет вовсе (вход был без них) — выдумывать цели за автора не наша
 * задача, это работа сигнала.
 */
async function rebalanceTpLadder(
  trx: Kysely<DB>,
  base: IntentBase,
  orderCtx: OrderContext,
  params: { tradeId: string; oldSize: Decimal; addedQty: Decimal; qtyStep: string },
): Promise<void> {
  if (params.oldSize.lte(0) || params.addedQty.lte(0)) return

  const liveTps = await trx
    .selectFrom('orders')
    .select(['order_link_id', 'price', 'qty', 'tp_index'])
    .where('trade_id', '=', params.tradeId)
    .where('purpose', '=', 'tp')
    .where('status', 'in', ['created', 'pending_submit', 'submitted'])
    .orderBy('tp_index', 'asc')
    .execute()
  if (liveTps.length === 0) return

  const ratio = params.oldSize.plus(params.addedQty).div(params.oldSize)
  const scaled: { price: string; qty: string; index: number }[] = []
  for (const [i, tp] of liveTps.entries()) {
    if (tp.price === null || tp.qty === null) continue
    const qty = floorTo(params.qtyStep, new Decimal(tp.qty).mul(ratio))
    if (qty.lte(0)) continue
    scaled.push({ price: new Decimal(tp.price).toString(), qty: qty.toString(), index: tp.tp_index ?? i })
  }
  // Ни одна ступень не выросла на целый шаг объёма — трогать биржу незачем.
  if (scaled.length === 0) return

  for (const tp of liveTps) {
    await base.deps.executionPort.cancelOrder(trx, { orderLinkId: tp.order_link_id })
  }
  // tpSeq=1: ключи прежней лесенки этого же действия уже заняты (доливка идёт под тем же
  // actionIndex, если сигнал пришёл одним сообщением) — иначе Bybit отвергнет дубликат.
  await base.deps.executionPort.placeTpLadder(trx, { ...orderCtx, tps: scaled, tpSeq: 1 })
  console.log(
    `[pipeline] ${orderCtx.symbol}: TP-лесенка пересчитана под новый объём ` +
      `(${params.oldSize.toString()} -> ${params.oldSize.plus(params.addedQty).toString()}): ` +
      scaled.map((t) => `${t.qty}@${t.price}`).join(', '),
  )
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

  // Ручное вмешательство оператора на бирже (закрытие/фиксация/сдвиг стопа руками) ставит
  // trades.manual_override — и с этого момента ВОЛЯ ОПЕРАТОРА ГЛАВНЕЕ сигнала канала: канал больше
  // не двигает защиту этой сделки. Иначе следующий tp_set «воскресил» бы лесенку, которую оператор
  // осознанно снял, а sl_set откатил бы стоп, который он подвинул руками.
  //
  // ИСКЛЮЧЕНИЕ: команды на ВЫХОД (close_remainder) исполняются ВСЕГДА. Блокировать закрытие позиции
  // опасно — это единственный способ канала вывести оператора из убытка.
  const trade = await trx
    .selectFrom('trades')
    .select(['manual_override', 'initial_size'])
    .where('id', '=', position.trade_id)
    .executeTakeFirst()
  const manualOverride = trade?.manual_override === true

  const isProtectionOp = (op: string): boolean =>
    op === 'sl_set' || op === 'sl_breakeven' || op === 'sl_cancel' || op === 'tp_set'

  if (manualOverride && intent.ops.length > 0 && intent.ops.every((op) => isProtectionOp(op.op))) {
    return { skipReason: 'manual_override' }
  }

  // Причина, по которой рыночный гейт не дал переставить стоп. Копим, а не выходим сразу: в одном
  // сообщении может быть и «зафиксировал половину», и «стоп в безубыток» — первое должно исполниться,
  // даже если второе пока невозможно.
  let gateSkip: string | null = null
  let executedOps = 0

  // ОСТАТОК ПОЗИЦИИ ВНУТРИ ОДНОГО СООБЩЕНИЯ. positions.size — это зеркало биржи, и после нашего
  // closePosition оно обновится только пришедшим ПОЗЖЕ WS-пушем. Поэтому все следующие операции
  // ЭТОГО ЖЕ сообщения обязаны считать от `remaining`, а не от position.size — иначе «фиксирую
  // половину, стоп на твх» выставит trading-stop (он идёт с tpslMode='Full' и slSize=qty) на ВДВОЕ
  // больший объём, чем реально остался.
  let remaining = new Decimal(position.size)
  // Порядковый номер закрывающего ордера: два closePosition в одном сообщении иначе получат
  // ОДИН orderLinkId, Bybit отвергнет дубликат и сообщение зациклится (см. ClosePositionParams.seq).
  let closeSeq = 0
  // Порядковый номер лесенки внутри одного action: два tp_set в одном сообщении иначе получат
  // одинаковые orderLinkId, Bybit отвергнет дубликат (110072) и сообщение зациклится.
  let tpSeq = 0

  // ДВОЙНОЕ ЗАКРЫТИЕ. «Первая цель взята» означает, что НАШ reduce-only TP-ордер исполнится САМ.
  // Если в том же сообщении автор добавляет «зафиксировал 50%» — это ОПИСАНИЕ того же самого
  // закрытия, а не вторая команда: закрыть ещё 50% рынком значит закрыть вдвое больше.
  // Подавляем фиксацию ТОЛЬКО когда лесенка реально стоит на бирже. Если живых TP-ордеров нет
  // (лесенку не ставили — например вход «с текущих» без целей), фиксацию исполняем.
  const tpHitInMessage = intent.ops.some((o) => o.op === 'tp_hit')
  const liveTpOrder = tpHitInMessage
    ? await trx
        .selectFrom('orders')
        .select('id')
        .where('trade_id', '=', position.trade_id)
        .where('purpose', '=', 'tp')
        .where('status', 'in', ['created', 'pending_submit', 'submitted'])
        .executeTakeFirst()
    : undefined
  const suppressPartialClose = liveTpOrder !== undefined

  for (const op of intent.ops) {
    if (manualOverride && isProtectionOp(op.op)) {
      console.warn(
        `[pipeline] ${intent.symbol}: '${op.op}' от канала пропущен — сделка под ручным управлением оператора (manual_override)`,
      )
      continue
    }
    switch (op.op) {
      case 'close_remainder':
        // Именно remaining, а не position.size: если выше в этом же сообщении уже зафиксировали
        // половину, зеркало биржи ещё не обновилось — закрывать надо то, что реально осталось.
        if (remaining.lte(0)) break
        await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: remaining.toString(), seq: closeSeq++ })
        await closeTrade(trx, { tradeId: position.trade_id })
        base.postCommit.push({ symbol: intent.symbol, tradeId: position.trade_id })
        remaining = new Decimal(0)
        executedOps++
        break
      case 'sl_breakeven': {
        // Безубыток = средняя цена входа (design spec §6: "LLM не считает арифметику... число
        // подставляет код из состояния позиции").
        if (position.avg_price === null) break
        // Позиция ушла в минус — стоп в безубыток оказался бы ПО ТУ СТОРОНУ рынка (для лонга выше
        // текущей цены). Биржа такой стоп отвергает (retCode 10001), и раньше это роняло всю
        // транзакцию: сообщение навсегда оставалось 'received' и переигрывалось каждые 5 секунд
        // (в живом инциденте — 108 раз, лоадер в UI висел вечно). Это не ошибка, а нормальная
        // рыночная ситуация: безубыток пока недостижим.
        const beGate = await stopLossReachable(base, intent.symbol, position.side, position.avg_price)
        if (beGate !== null) {
          gateSkip = beGate
          break
        }
        await base.deps.executionPort.setStopLoss(trx, { ...orderCtx, price: position.avg_price, qty: remaining.toString() })
        executedOps++
        break
      }
      case 'sl_set': {
        // Тот же гейт: автор может прислать стоп, который рынок уже прошёл.
        const slGate = await stopLossReachable(base, intent.symbol, position.side, op.price.toString())
        if (slGate !== null) {
          gateSkip = slGate
          break
        }
        await base.deps.executionPort.setStopLoss(trx, { ...orderCtx, price: op.price.toString(), qty: remaining.toString() })
        executedOps++
        break
      }
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
      case 'sl_hit':
        // СОБЫТИЕ, А НЕ КОМАНДА. «Выбило по стопу» означает, что сработал стоп у АВТОРА; наш
        // собственный стоп уходит на биржу АТОМАРНО со входом (bybit.adapter.ts::placeEntry) и
        // сработает сам по своей цене. Событие уже зафиксировано строкой actions, ордеров не требует.
        break

      case 'tp_hit': {
        // «Первая цель взята» — тоже событие. Пока на бирже стоит НАШ reduce-only TP-ордер, делать
        // нечего: он исполнится сам, по той же цене (закрыть ещё и рынком значило бы закрыть вдвое
        // больше). Если автор в том же сообщении назвал долю («зафиксировал 50%»), её исполнит
        // ветка partial_close — здесь не дублируем.
        if (suppressPartialClose || intent.ops.some((o) => o.op === 'partial_close')) break

        // ⚠️ А ВОТ ЕСЛИ TP-ОРДЕРА НЕТ — раньше здесь не происходило НИЧЕГО, и это стоило денег.
        // Живой случай (TR-1048, 28.07.2026): вход был «Long btc с текущих», целей в сигнале не
        // было, лесенку никто не ставил. Автор объявил цель — бот записал событие и промолчал,
        // хотя закрывать объём было нечему. Решение заказчика: закрываем долю сами — названную в
        // сообщении (её берёт partial_close выше) либо треть по умолчанию, исходя из типичной
        // лесенки в три цели.
        const instrument = base.instruments.get(intent.symbol)
        if (!instrument) {
          gateSkip = 'symbol_not_listed'
          break
        }

        // Гейт здравого смысла: «цель взята» при позиции В УБЫТКЕ — противоречие. Так выглядит
        // ошибка разбора («64200 первый таргет» модель приняла за достигнутую цель, хотя цена до
        // неё не доходила). Закрыть треть в минус по ошибке дороже, чем показать оператору вопрос.
        if (position.mark_price !== null && position.avg_price !== null) {
          const mark = new Decimal(position.mark_price)
          const entry = new Decimal(position.avg_price)
          const inProfit = position.side === 'long' ? mark.gt(entry) : mark.lt(entry)
          if (!inProfit) {
            gateSkip = 'tp_not_reached'
            break
          }
        }

        // Базис — ВЕСЬ вложенный объём (вход + доливки): лесенка из трёх целей делит на равные
        // части именно его, поэтому «первая цель» закрывает треть позиции, а не треть остатка и не
        // треть первого входа (после доливки это разные числа, см. resolveLadderBasis).
        const basis = await resolveLadderBasis(trx, position.trade_id, remaining)
        const closeQty = Decimal.min(floorTo(instrument.qtyStep, basis.mul(DEFAULT_TP_HIT_FRACTION)), remaining)
        if (closeQty.lte(0)) {
          gateSkip = 'zero_qty'
          break
        }

        if (closeQty.gte(remaining)) {
          await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: remaining.toString(), seq: closeSeq++ })
          await closeTrade(trx, { tradeId: position.trade_id })
          base.postCommit.push({ symbol: intent.symbol, tradeId: position.trade_id })
          remaining = new Decimal(0)
          executedOps++
          break
        }

        await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: closeQty.toString(), seq: closeSeq++ })
        remaining = remaining.minus(closeQty)
        await trx
          .updateTable('trades')
          .set({ status: 'partially_closed', updated_at: new Date() })
          .where('id', '=', position.trade_id)
          .execute()
        executedOps++
        break
      }

      case 'partial_close': {
        // КОМАНДА: автор закрывает часть позиции руками («фиксирую половину», «закрыл 50%»).
        // Раньше лежало в одной ветке с событиями выше и было no-op — бот игнорировал прямое
        // указание автора и держал полный объём, пока тот уже сократил риск.
        if (suppressPartialClose) {
          // В сообщении есть и «цель взята», и «зафиксировал» — это одно и то же закрытие,
          // и наш TP-ордер отработает его сам.
          console.warn(
            `[pipeline] ${intent.symbol}: 'partial_close' подавлен — в сообщении есть tp_hit, а на бирже стоит наш TP-ордер (он закроет объём сам)`,
          )
          break
        }

        const instrument = base.instruments.get(intent.symbol)
        if (!instrument) {
          gateSkip = 'symbol_not_listed'
          break
        }

        // «Скинул один объём» — закрывается ЛЕГА (доливка) целиком, а не доля позиции: маркер
        // one_unit доезжал из модели и молча игнорировался, вместо доливки закрывалась половина.
        const unitQty = op.unit === 'one_unit' ? await resolveOneUnitQty(trx, position.trade_id) : null

        // Доля: «половину» → 0.5. Базис — остаток (автор говорит про то, что видит СЕЙЧАС), либо
        // исходный объём, если модель явно указала basis='original'.
        const fraction = new Decimal(op.fraction ?? DEFAULT_PARTIAL_CLOSE_FRACTION)
        const basisSize =
          op.basis === 'original' && trade?.initial_size != null ? new Decimal(trade.initial_size) : remaining

        // Округляем ВНИЗ к шагу объёма — иначе биржа отвергнет ордер. И не закрываем больше остатка.
        const closeQty = Decimal.min(floorTo(instrument.qtyStep, unitQty ?? basisSize.mul(fraction)), remaining)

        if (closeQty.lte(0)) {
          gateSkip = 'zero_qty' // остаток меньше шага объёма — «половину» физически нечем закрыть
          break
        }

        if (closeQty.gte(remaining)) {
          // Доля покрыла весь остаток — это уже полный выход, а не фиксация части.
          await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: remaining.toString(), seq: closeSeq++ })
          await closeTrade(trx, { tradeId: position.trade_id })
          base.postCommit.push({ symbol: intent.symbol, tradeId: position.trade_id })
          remaining = new Decimal(0)
          executedOps++
          break
        }

        await base.deps.executionPort.closePosition(trx, { ...orderCtx, qty: closeQty.toString(), seq: closeSeq++ })
        remaining = remaining.minus(closeQty)
        // Статус «частично закрыта» до этого не писал НИКТО — колонка была мертва, и в UI сделка
        // после фиксации половины выглядела как обычная открытая.
        await trx
          .updateTable('trades')
          .set({ status: 'partially_closed', updated_at: new Date() })
          .where('id', '=', position.trade_id)
          .execute()
        executedOps++
        break
      }
      case 'tp_set': {
        // modify_tp (Ф2, AI-канал: "Следующие цели 72.7, 74"). Ступени считаются от ИСХОДНОГО
        // объёма сделки, но ограничены остатком — иначе после фиксации части в этом же сообщении
        // («первая цель взята… следующая цель 1960») лесенка выставила бы больше, чем есть.
        if (remaining.lte(0)) break // выше по циклу позицию уже закрыли целиком — вешать нечего
        const skip = await handleTpSet(trx, base, orderCtx, {
          symbol: intent.symbol,
          tradeId: position.trade_id,
          side: position.side,
          basis: await resolveLadderBasis(trx, position.trade_id, remaining),
          remaining,
          markPrice: position.mark_price,
          targets: op.targets,
          ...(op.ladderTotal !== undefined ? { ladderTotal: op.ladderTotal } : {}),
          tpSeq: tpSeq++,
        })
        if (skip !== null) gateSkip = skip
        else executedOps++
        break
      }
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

  // Ни одно действие не исполнилось, и причина — рыночный гейт: показываем оператору ПОЧЕМУ
  // («безубыток пока недостижим»), вместо того чтобы уронить транзакцию об отказ биржи.
  if (gateSkip !== null && executedOps === 0) return { skipReason: gateSkip }

  return { tradeId: position.trade_id, side: position.side, symbol: intent.symbol }
}

/**
 * Можно ли вообще поставить такой стоп прямо сейчас.
 *
 * Стоп обязан стоять ПО ТУ СТОРОНУ рынка, куда идёт убыток: для лонга — НИЖЕ текущей цены, для шорта
 * — ВЫШЕ. Иначе он сработал бы мгновенно, и биржа его просто отвергает (retCode 10001
 * «StopLoss ... should lower than base_price»).
 *
 * Самый частый случай — «стоп в безубыток», когда позиция ушла в минус: безубыток оказывается выше
 * рынка для лонга. Это НЕ ошибка, а нормальная рыночная ситуация. Раньше отказ биржи ронял всю
 * транзакцию сообщения: оно навсегда оставалось в статусе 'received' и переигрывалось каждые 5 секунд
 * (живой инцидент: 108 повторов, в UI вечно крутился лоадер «Разбираем сообщение…»).
 *
 * `null` — стоп поставить можно. Строка — причина пропуска.
 *
 * Без источника цены (dry_run) гейт не применяется: сети там нет, а симулированный стоп никого не
 * ликвидирует.
 */
async function stopLossReachable(
  base: IntentBase,
  symbol: string,
  side: Side,
  slPrice: string,
): Promise<string | null> {
  if (!base.deps.getMarkPrice) return null

  const mark = await base.deps.getMarkPrice(symbol)
  if (mark === null) return 'mark_price_unavailable' // fail-closed: вслепую стоп не двигаем

  const sl = new Decimal(slPrice)
  const current = new Decimal(mark)
  const unreachable = side === 'long' ? sl.gte(current) : sl.lte(current)
  if (!unreachable) return null

  console.warn(
    `[pipeline] ${symbol}: стоп ${sl.toString()} по ту сторону рынка (${current.toString()}, ${side}) — ` +
      `биржа отвергнет такой стоп, пропускаю`,
  )
  return 'sl_beyond_market'
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
  params: {
    symbol: string
    tradeId: string
    side: Side
    /** Исходный объём сделки — от него считаются ступени лесенки. */
    basis: Decimal
    /** Сколько объёма реально осталось: суммарно лесенка не может его превысить. */
    remaining: Decimal
    markPrice: string | null
    targets: ReadonlyArray<{ value?: number; marker?: 'current_price'; index?: number; fraction?: number; unit?: 'one_unit' }>
    /** Число целей в лесенке, названное автором. */
    ladderTotal?: number
    /** Порядковый номер лесенки внутри одного action (уникальность orderLinkId). */
    tpSeq: number
  },
): Promise<string | null> {
  const markPrice = params.markPrice !== null ? new Decimal(params.markPrice) : null
  // Цель размером «одна доливка» («после усреднения твх 1.03, там буду скидывать доливку»):
  // объём берём у самой леги, автор его в процентах не называет.
  const oneUnitQty = params.targets.some((t) => t.unit === 'one_unit') ? await resolveOneUnitQty(trx, params.tradeId) : null
  const resolved: { price: Decimal; index?: number; fraction?: number; qty?: Decimal }[] = []
  // Считаем ОТДЕЛЬНО цели, у которых не вышло определить ЦЕНУ: это признак неполного разбора всего
  // сообщения (гейт ниже), тогда как цель, чей РАЗМЕР («одна доливка») определить нечем, — просто
  // невыполнимая цель, из-за неё остальную лесенку терять незачем.
  let unresolvedPrice = 0
  for (const target of params.targets) {
    const price = target.value !== undefined ? new Decimal(target.value) : target.marker === 'current_price' && markPrice !== null ? markPrice : null
    if (price === null) {
      unresolvedPrice += 1
      continue
    }
    if (target.unit === 'one_unit' && oneUnitQty === null) {
      // Доливок у сделки нет — «скинуть доливку» нечем. Ставить вместо неё обычную ступень
      // лесенки значило бы выдумать за автора объём, которого он не называл.
      console.warn(`[pipeline] ${params.symbol}: цель ${price.toString()} размером «одна доливка», но доливок у сделки нет — цель пропущена`)
      continue
    }
    resolved.push({
      price,
      ...(target.index !== undefined ? { index: target.index } : {}),
      ...(target.fraction !== undefined ? { fraction: target.fraction } : {}),
      ...(target.unit === 'one_unit' && oneUnitQty !== null ? { qty: oneUnitQty } : {}),
    })
  }
  if (unresolvedPrice > 0 || resolved.length === 0) {
    console.warn(`[pipeline] modify_tp: не все цели резолвились (current_price без mark_price?), symbol=${params.symbol} — лесенка не обновлена`)
    return null
  }

  const instrument = base.instruments.get(params.symbol)
  if (!instrument) return 'symbol_not_listed'

  // ГЕЙТ ЦЕНЫ, зеркальный стоповому (stopLossReachable): reduce-only лимитка ПО ТУ СТОРОНУ рынка
  // исполнится немедленно — то есть «поставить тейк» тихо превратилось бы в закрытие по рынку
  // прямо сейчас. Для лонга цель обязана быть ВЫШЕ рынка, для шорта — ниже.
  const liveMark = base.deps.getMarkPrice ? await base.deps.getMarkPrice(params.symbol) : null
  const guardMark = liveMark !== null ? new Decimal(liveMark) : null
  const reachable = guardMark === null ? resolved : resolved.filter((t) => (params.side === 'long' ? t.price.gt(guardMark) : t.price.lt(guardMark)))
  if (reachable.length === 0) {
    console.warn(
      `[pipeline] ${params.symbol}: все цели ${resolved.map((t) => t.price.toString()).join(', ')} по ту сторону рынка ` +
        `(${guardMark?.toString() ?? '—'}, ${params.side}) — лесенка не тронута`,
    )
    return 'tp_beyond_market'
  }

  // Объём, уже расписанный по целям-легам, из базиса лесенки вычитается: ступени делят ТО, ЧТО
  // ОСТАЁТСЯ. Иначе в сообщении «на 1.03 скину доливку, первый таргет 1.048» первая цель забрала бы
  // треть ВСЕЙ позиции вместе с доливкой, которая по замыслу автора выходит отдельно и раньше.
  const earmarked = reachable.reduce((sum, t) => (t.qty !== undefined ? sum.plus(t.qty) : sum), new Decimal(0))
  const ladderBasis = Decimal.max(0, params.basis.minus(earmarked))

  const tpTargets = buildLadderTargets({
    basis: ladderBasis,
    remaining: params.remaining,
    targets: reachable,
    ...(params.ladderTotal !== undefined ? { ladderTotal: params.ladderTotal } : {}),
    qtyStep: instrument.qtyStep,
  })
  // Пусто — все ступени меньше шага объёма. Старую лесенку в этом случае НЕ трогаем: снять
  // существующий выход и не поставить новый — худший из возможных исходов.
  if (tpTargets.length === 0) return 'zero_qty'

  // Отмена старых целей — ТОЛЬКО после того, как новая лесенка посчиталась непустой. Если автор
  // назвал ступени по номерам, заменяем ровно эти ступени: иначе следующее сообщение («вторая
  // цель 1960») снесло бы правильно выставленную первую.
  const replacedIndexes = new Set(reachable.map((t) => t.index).filter((i): i is number => i !== undefined))
  const partialReplace = replacedIndexes.size === reachable.length && replacedIndexes.size > 0
  let activeTps = await trx
    .selectFrom('orders')
    .select(['order_link_id', 'tp_index'])
    .where('trade_id', '=', params.tradeId)
    .where('purpose', '=', 'tp')
    .where('status', 'in', ['created', 'pending_submit', 'submitted'])
    .execute()
  if (partialReplace) {
    activeTps = activeTps.filter((o) => o.tp_index !== null && replacedIndexes.has(o.tp_index))
  }
  for (const activeTp of activeTps) {
    await base.deps.executionPort.cancelOrder(trx, { orderLinkId: activeTp.order_link_id })
  }

  await base.deps.executionPort.placeTpLadder(trx, { ...orderCtx, tps: tpTargets, tpSeq: params.tpSeq })
  return null
}
