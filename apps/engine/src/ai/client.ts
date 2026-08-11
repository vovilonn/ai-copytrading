// AI-клиент к ai-proxy (research/ai-layer.md): forced tool_use, vision, prompt caching, ретраи с
// backoff, эскалация Sonnet→Opus, опциональная запись в ai_calls. Единственная точка выхода
// AI-слоя в Bybit-пайплайн (Ф2).
//
// ВАЖНО (проверенные факты окружения, research §1/§10):
// - POST {AI_PROXY_URL}/v1/messages, headers content-type + anthropic-version, ключ НЕ нужен.
// - Поле `system` прокси МОЛЧА игнорирует → вся инструкция в первом user-блоке (prompt.ts).
// - tool_choice:{type:'tool',name:'extract_signal'} форсит инструмент (0 отказов на 460 вызовах).
// - Кэшируемый prefix (tools+CC-система+инструкция) детерминирован — без даты/uuid.

import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { EXTRACT_SIGNAL_TOOL, type ExtractSignalOutput } from './schema.js'
import { buildUserTurn, type AnthropicContentBlock, type BuildUserTurnParams, type PromptImage } from './prompt.js'

/** Версия промпта — часть ключа кэша разбора и колонки ai_calls.prompt_version (research §10). */
export const PROMPT_VERSION = 'extract_signal.v7'

/** Модели (research §8, ЖЁСТКО заданы задачей — основная и эскалация). */
export const MODEL_SONNET = 'claude-sonnet-4-5-20250929'
export const MODEL_OPUS = 'claude-opus-4-8'

const DEFAULT_AI_PROXY_URL = 'http://127.0.0.1:8317'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 2048

// Important #1 адверсариального ревью (p2-final-fix-report.md): fetch БЕЗ AbortController может
// висеть неопределённо долго на дефолтах undici (нет socket-таймаута), а callOnce вызывается из
// runAiBranch ВНУТРИ db.transaction() (pipeline.ts) — зависший ai-proxy держал бы открытой
// транзакцию (xmin, строчные локи) на всё время зависания. 40с — дефолт (задача); переопределим
// явным параметром (тесты) либо env AI_PROXY_TIMEOUT_MS.
const DEFAULT_FETCH_TIMEOUT_MS = 40_000

function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const envVal = process.env.AI_PROXY_TIMEOUT_MS
  if (envVal !== undefined) {
    const parsed = Number(envVal)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_FETCH_TIMEOUT_MS
}

// Ретраи (research §11): 429/500/502/503/529 ретраить с экспоненциальным backoff (4 попытки,
// 2^att c), 400/404/413 НЕ ретраить (лог, needs_human). httpStatus=0 (сетевой сбой) — ретраить.
const MAX_ATTEMPTS = 4
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529])
const NON_RETRYABLE_STATUSES = new Set([400, 404, 413])

// Цены за 1M токенов, USD (research §6/§10 и прайс Anthropic на дату задачи). Cache-write = 1.25×
// input, cache-read = 0.1× input. Оценка cost_usd — приблизительная (для дэшборда/учёта), не биллинг.
interface ModelPricing {
  inputPerM: number
  outputPerM: number
  cacheWritePerM: number
  cacheReadPerM: number
}
const PRICING: Record<string, ModelPricing> = {
  // Sonnet 4.5: $3 / $15 за 1M.
  [MODEL_SONNET]: { inputPerM: 3, outputPerM: 15, cacheWritePerM: 3.75, cacheReadPerM: 0.3 },
  // Opus 4.8: $5 / $25 за 1M.
  [MODEL_OPUS]: { inputPerM: 5, outputPerM: 25, cacheWritePerM: 6.25, cacheReadPerM: 0.5 },
}

export interface AiUsage {
  inputTokens: number
  cacheCreation: number
  cacheRead: number
  outputTokens: number
}

export interface CallExtractSignalResult {
  output: ExtractSignalOutput
  usage: AiUsage
  model: string
  latencyMs: number
  cacheHit: boolean
}

export interface CallExtractSignalParams extends Omit<BuildUserTurnParams, 'images'> {
  images: PromptImage[]
  /** Модель запроса. Дефолт — Sonnet (основная ступень). Opus подаётся при эскалации вызывающей стороной. */
  model?: string
  /** Опционально: БД для записи ai_calls. Не передан — не пишем (чистые тесты/офлайн). */
  db?: Kysely<AiCallsSchema>
  /** Опционально: id сообщения (FK ai_calls.message_id). */
  messageId?: string | null
  /** Опционально: id parse_results (FK ai_calls.parse_result_id). */
  parseResultId?: string | null
  /** Помечает вызов как эскалацию (ai_calls.escalated). */
  escalated?: boolean
  /** Базовый URL прокси. Дефолт — env AI_PROXY_URL, иначе http://127.0.0.1:8317. */
  baseUrl?: string
  /** Таймаут ОДНОГО HTTP-вызова прокси, мс (Important #1 адверсариального ревью). Дефолт — env
   *  AI_PROXY_TIMEOUT_MS, иначе 40000. Тесты передают короткий таймаут явно, чтобы не ждать
   *  реальные 40с на попытку зависшего fetch. */
  timeoutMs?: number
}

// Kysely-схема только для таблицы ai_calls (в api/db/database.ts она НЕ типизирована — там комментарий
// «объявляются по мере использования»). Локально типизируем ровно колонки из миграции 001_initial.ts,
// чтобы insert был type-safe без правки чужого пакета (задача просит не трогать apps/api).
export interface AiCallsSchema {
  ai_calls: {
    message_id: string | null
    parse_result_id: string | null
    model: string
    prompt_version: string
    request_hash: string
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    output_tokens: number
    cost_usd: string
    latency_ms: number
    http_status: number | null
    attempt: number
    cache_hit: boolean
    escalated: boolean
    error: string | null
  }
}

/** Ошибка HTTP от прокси с кодом — для решения ретраить/эскалировать и записи http_status. */
export class AiProxyError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'AiProxyError'
  }
}

interface AnthropicUsageRaw {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

interface AnthropicContentToolUse {
  type: 'tool_use'
  name: string
  input: unknown
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicContentToolUse | { type: string }>
  usage?: AnthropicUsageRaw
}

function resolveBaseUrl(explicit?: string): string {
  return explicit ?? process.env.AI_PROXY_URL ?? DEFAULT_AI_PROXY_URL
}

/** request_hash (research §10): детерминированный ключ по модели+prompt_version+контенту запроса. */
function computeRequestHash(model: string, blocks: AnthropicContentBlock[]): string {
  // Картинки в хэш — по sha256 их base64, а не по всему base64 (иначе хэш огромный и медленный),
  // и без cache_control-мета (она не влияет на смысл запроса).
  const canonical = blocks.map((b) => {
    if (b.type === 'text') return { t: 'text', text: b.text }
    return { t: 'image', media: b.source.media_type, sha: createHash('sha256').update(b.source.data).digest('hex') }
  })
  return createHash('sha256').update(`${model}\n${PROMPT_VERSION}\n${JSON.stringify(canonical)}`).digest('hex')
}

function estimateCostUsd(model: string, usage: AiUsage): string {
  const p = PRICING[model]
  if (!p) return '0'
  const cost =
    (usage.inputTokens * p.inputPerM +
      usage.cacheCreation * p.cacheWritePerM +
      usage.cacheRead * p.cacheReadPerM +
      usage.outputTokens * p.outputPerM) /
    1_000_000
  // NUMERIC(12,6) в схеме — 6 знаков после запятой (деньги — строка, не float, DRY с остальной схемой).
  return cost.toFixed(6)
}

function classifyStatus(status: number): { retryable: boolean } {
  if (RETRYABLE_STATUSES.has(status)) return { retryable: true }
  if (NON_RETRYABLE_STATUSES.has(status)) return { retryable: false }
  // Прочие 4xx — не ретраить; прочие 5xx — ретраить (консервативно, как в харнессе research §11).
  return { retryable: status >= 500 }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Один HTTP-вызов прокси. Кидает AiProxyError на не-2xx, парсит tool_use.input и usage. */
async function callOnce(
  baseUrl: string,
  model: string,
  blocks: AnthropicContentBlock[],
  timeoutMs: number,
): Promise<{ output: ExtractSignalOutput; usage: AiUsage; httpStatus: number }> {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    tools: [EXTRACT_SIGNAL_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_SIGNAL_TOOL.name },
    messages: [{ role: 'user', content: blocks }],
  }

  // Important #1 адверсариального ревью: AbortController с таймаутом — без него зависший
  // ai-proxy держал бы fetch (и открытую транзакцию pipeline.ts::runAiBranch) неопределённо
  // долго на дефолтах undici. clearTimeout — в finally, чтобы не оставлять активный таймер
  // после успешного (или любого другого) завершения вызова.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      // Сетевой сбой (прокси недоступен, DNS, reset) ИЛИ таймаут (AbortError от ctrl.abort()) —
      // оба httpStatus=0, ретраить (research §11) — таймаут трактуется как обычный сетевой сбой,
      // не отдельный кейс: попадает в те же 4 попытки backoff, а после исчерпания — деградация
      // (needs_review/ai_unavailable выше по стеку, reconciler.ts), НЕ вечное удержание транзакции.
      throw new AiProxyError(`сеть: ${(err as Error).message}`, 0, true)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const { retryable } = classifyStatus(res.status)
      throw new AiProxyError(`ai-proxy ${res.status}: ${text.slice(0, 300)}`, res.status, retryable)
    }

    const json = (await res.json()) as AnthropicMessageResponse
    const toolUse = json.content?.find((b): b is AnthropicContentToolUse => b.type === 'tool_use')
    if (!toolUse) {
      // Форсированный tool_choice → ответ ОБЯЗАН содержать tool_use (0 отказов на 460 вызовах §1).
      // Отсутствие — аномалия ответа: не ретраить бесконечно, но это ошибка формата (не наша схема).
      throw new AiProxyError('ответ прокси без tool_use-блока', res.status, false)
    }

    const usageRaw = json.usage ?? {}
    const usage: AiUsage = {
      inputTokens: usageRaw.input_tokens ?? 0,
      cacheCreation: usageRaw.cache_creation_input_tokens ?? 0,
      cacheRead: usageRaw.cache_read_input_tokens ?? 0,
      outputTokens: usageRaw.output_tokens ?? 0,
    }

    return { output: toolUse.input as ExtractSignalOutput, usage, httpStatus: res.status }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Форсированный extract_signal-вызов к ai-proxy с ретраями и опциональной записью ai_calls.
 * Собирает user-turn (buildUserTurn), POST-ит на прокси, извлекает tool_use.input.
 *
 * Ретраи (research §11): 429/500/502/503/529 и сетевые сбои — до 4 попыток с backoff 2^att c;
 * 400/404/413 — сразу пробрасываем (лог, needs_human выше по стеку). При исчерпании попыток
 * пишем ошибочную строку ai_calls (если db передан) и пробрасываем последнюю ошибку.
 */
export async function callExtractSignal(params: CallExtractSignalParams): Promise<CallExtractSignalResult> {
  const model = params.model ?? MODEL_SONNET
  const baseUrl = resolveBaseUrl(params.baseUrl)
  const blocks = buildUserTurn({
    text: params.text,
    tMsg: params.tMsg,
    replyParentText: params.replyParentText,
    replyChain: params.replyChain,
    replyChainSymbol: params.replyChainSymbol,
    openPositions: params.openPositions,
    images: params.images,
  })
  const requestHash = computeRequestHash(model, blocks)
  const timeoutMs = resolveTimeoutMs(params.timeoutMs)

  const startedAt = Date.now()
  let lastError: AiProxyError | Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { output, usage, httpStatus } = await callOnce(baseUrl, model, blocks, timeoutMs)
      const latencyMs = Date.now() - startedAt
      const cacheHit = usage.cacheRead > 0

      await writeAiCall(params, {
        model,
        requestHash,
        usage,
        latencyMs,
        httpStatus,
        attempt,
        cacheHit,
        error: null,
      })

      return { output, usage, model, latencyMs, cacheHit }
    } catch (err) {
      lastError = err as Error
      const retryable = err instanceof AiProxyError ? err.retryable : true
      const httpStatus = err instanceof AiProxyError ? err.httpStatus : 0

      if (!retryable || attempt === MAX_ATTEMPTS) {
        const latencyMs = Date.now() - startedAt
        await writeAiCall(params, {
          model,
          requestHash,
          usage: { inputTokens: 0, cacheCreation: 0, cacheRead: 0, outputTokens: 0 },
          latencyMs,
          httpStatus,
          attempt,
          cacheHit: false,
          error: lastError.message.slice(0, 1000),
        })
        throw lastError
      }

      // Backoff 2^att секунд (research §11): att=1 → 2c, att=2 → 4c, att=3 → 8c.
      await sleep(2 ** attempt * 1000)
    }
  }

  // Недостижимо (цикл всегда либо возвращает, либо кидает) — для полноты типов.
  throw lastError ?? new Error('callExtractSignal: неизвестная ошибка')
}

interface WriteAiCallArgs {
  model: string
  requestHash: string
  usage: AiUsage
  latencyMs: number
  httpStatus: number
  attempt: number
  cacheHit: boolean
  error: string | null
}

/**
 * Пишет одну строку ai_calls, если db передан. Ошибку записи глотаем (учёт не должен ронять разбор).
 *
 * Minor #4 адверсариального ревью (p2-final-fix-report.md): вызывающая сторона (pipeline.ts::
 * runAiBranch) передаёт сюда `db` НЕ как trx сообщения, а как ОТДЕЛЬНОЕ соединение пула — insert
 * ai_calls больше не часть транзакции processMessage. Поэтому: (1) упавший statement здесь НЕ
 * отравляет транзакцию сообщения (PG аварийно завершает только СВОЁ соединение/транзакцию, а не
 * весь пул), console.warn ниже действительно безопасен, а не маскирует откат; (2) учёт стоимости
 * не теряется, если транзакция сообщения позже откатится по другой причине — деньги на AI-вызов
 * уже потрачены независимо от судьбы этой транзакции. Если когда-нибудь вызовут с db=trx
 * (например, из теста) — поведение не изменится (тот же insert), просто вернётся прежний риск
 * поглощения ошибки на транзакции; в остальном коде так больше не делаем.
 */
async function writeAiCall(params: CallExtractSignalParams, args: WriteAiCallArgs): Promise<void> {
  if (!params.db) return
  try {
    await params.db
      .insertInto('ai_calls')
      .values({
        message_id: params.messageId ?? null,
        parse_result_id: params.parseResultId ?? null,
        model: args.model,
        prompt_version: PROMPT_VERSION,
        request_hash: args.requestHash,
        input_tokens: args.usage.inputTokens,
        cache_creation_input_tokens: args.usage.cacheCreation,
        cache_read_input_tokens: args.usage.cacheRead,
        output_tokens: args.usage.outputTokens,
        cost_usd: estimateCostUsd(args.model, args.usage),
        latency_ms: args.latencyMs,
        // http_status колонка nullable, но 0 (сетевой сбой) отличаем от «не заполнено».
        http_status: args.httpStatus,
        attempt: args.attempt,
        cache_hit: args.cacheHit,
        escalated: params.escalated ?? false,
        error: args.error,
      })
      .execute()
  } catch (err) {
    console.warn('[ai] не удалось записать ai_calls:', (err as Error).message)
  }
}
