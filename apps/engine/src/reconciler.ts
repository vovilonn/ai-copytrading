import type { ActionType, DeltaOp, ParsedIntent, ParsedResult, Side } from 'shared/domain.js'

/**
 * Reconciler (design spec §6, task-7-brief.md; Ф2 — research/ai-layer.md §8/§11/§12,
 * task-4-brief.md) — сливает вывод ДЕТЕРМИНИРОВАННОГО парсера И (когда он вызывался) AI-разбора
 * в единое решение о судьбе СООБЩЕНИЯ и назначает КАНОНИЧЕСКИЙ `actionIndex` каждому intent'у.
 *
 * Ф1 (route!=='ai' у детерминированного парсера, ai всегда null) — путь без изменений:
 * `execute` → исполнять; `skip` → skipped с причиной парсера; `noise` → noise.
 *
 * Ф2 (детерминированный route==='ai' — CH2 не смог распознать шаблон, ЛИБО шаблон распознан,
 * но вызывающая сторона всё же прогнала через AI для сверки) — правила §12, ДОСЛОВНО:
 *  1. Шаблон совпал ∧ AI согласен по (symbol,side,type) → числа из ДЕТЕРМИНИРОВАННОГО, Method 'auto'.
 *  2. Шаблон НЕ совпал (терс/картинка/free-form) → всё из AI, Method 'ai'.
 *  3. Шаблон совпал, но AI дал ДРУГОЙ symbol/side/type ИЛИ AI поднял needs_human → конфликт:
 *     НЕ исполнять, outcome needs_review, reason 'parser_disagreement', ручная проверка.
 *  4. symbol=UNKNOWN от AI, но шаблон дал символ → берём детерминированный символ (rule 1 с
 *     дополнительной терпимостью к недобору контекста у AI).
 *
 * Гейт исполнения (§8/§11): symbol UNKNOWN / needs_human / confidence<AI_CONFIDENCE_GATE /
 * конфликт det/ai → route needs_review, НЕ исполняем (fail-safe: "лучше needs_review, чем
 * неверное исполнение").
 *
 * `actionIndex` — позиция intent'а в итоговом массиве intents (детерминированного ИЛИ AI —
 * смотря откуда взято решение), ровно как его отдал источник. Стабильно и детерминированно,
 * ПОКА источник — чистая функция одного и того же входа (адаптер — текста; AI — закэширован
 * по ai/cache.ts) — повторная обработка того же сообщения даёт тот же массив intents в том же
 * порядке, значит и тот же actionIndex на каждый intent. Это ровно то, что требует идемпотентность
 * orderLinkId ниже по пайплайну (order-link-id.ts).
 */

export type MessageOutcome = 'executing' | 'needs_review' | 'skipped' | 'noise'

/** Method (UI-поле, design spec §6 / research §12): откуда взято итоговое решение. null — noise
 *  (сообщение не несёт action вовсе, парсить нечего). */
export type Method = 'auto' | 'ai' | 'review' | null

export interface DecidedIntent {
  readonly actionIndex: number
  readonly intent: ParsedIntent
}

export interface Decision {
  readonly outcome: MessageOutcome
  readonly method: Method
  readonly decided: readonly DecidedIntent[]
  /** Причина skipped/needs_review — ParsedResult.reason парсера, ЛИБО одна из reconciler-специфичных:
   *  'parser_disagreement' (rule 3) | 'ai_unavailable' (деградация) | 'low_confidence' (гейт §8/§11). */
  readonly reason?: string
}

/** Реконсиляция читает channelId только для диагностических логов (конфликт/деградация) —
 *  сама логика слияния от канала не зависит. */
export interface ReconcileContext {
  readonly channelId: number
}

/** Гейт уверенности AI-исполнения (research §8/§11: эскалация Sonnet→Opus и needs_review при
 *  confidence<0.7 — ОДНО и то же пороговое значение используется и пайплайном для решения об
 *  эскалации, и здесь для финального гейта исполнения после (возможной) эскалации). */
export const AI_CONFIDENCE_GATE = 0.7

/**
 * Классифицирует ОДИН ParsedIntent в плоскую сигнатуру (symbol/side/type ActionType) —
 * используется И для сравнения детерминированного/AI-разбора при реконсиляции (ниже), И
 * пайплайном (apps/engine/src/pipeline.ts) для заполнения actions.type/side/symbol. Единственный
 * источник этой классификации (DRY) — раньше дублировался в pipeline.ts.
 */
export function classifyIntent(intent: ParsedIntent): { type: ActionType; side: Side | null; symbol: string | null } {
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

// Приоритет для поля `type` итоговой actions-строки, когда intent несёт НЕСКОЛЬКО ops разом
// (напр. management_multi "MET:{fix,close}" — событие partial_close и команда close_remainder
// одновременно): команды важнее событий, close_remainder — самый весомый исход (сделка закрылась).
// tp_set/cancel_pending (Ф2, normalize-output.ts) — ниже Ф1-набора по значимости (обновление
// TP-лесенки/отмена pending-ордера не так критичны, как факт закрытия/SL).
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
  return ops[0]?.op ?? 'hold' // ops никогда не пуст здесь (адаптер/normalizeAiOutput гарантируют ops.length>0)
}

function toDecided(intents: readonly ParsedIntent[]): DecidedIntent[] {
  return intents.map((intent, actionIndex) => ({ actionIndex, intent }))
}

/**
 * @param deterministic Результат adapter.parse() — ВСЕГДА присутствует (детерминированный парсер
 *   вызывается на каждое сообщение).
 * @param ai Результат normalizeAiOutput() — присутствует, только если пайплайн реально вызвал AI
 *   (route==='ai' у deterministic) И вызов УСПЕШНО завершился. null означает: AI не понадобился
 *   (deterministic.route!=='ai' — Ф1-путь) ИЛИ AI понадобился, но недоступен (деградация §11).
 *   Различить эти два случая эта функция может только по deterministic.route.
 */
export function reconcile(deterministic: ParsedResult, ai: ParsedResult | null, ctx: ReconcileContext): Decision {
  switch (deterministic.route) {
    case 'noise':
      return { outcome: 'noise', method: null, decided: [] }
    case 'skip':
      return { outcome: 'skipped', method: 'auto', decided: [], reason: deterministic.reason ?? 'skip' }
    case 'execute':
      return reconcileExecuteRoute(deterministic, ai, ctx)
    case 'ai':
      return reconcileAiRoute(ai, ctx)
  }
}

/** Шаблон СОВПАЛ (deterministic.route==='execute') — §12 rules 1/3/4. */
function reconcileExecuteRoute(det: ParsedResult, ai: ParsedResult | null, ctx: ReconcileContext): Decision {
  if (ai === null) {
    // AI не вызывался вовсе (Ф1-путь: CH1 никогда не зовёт AI; CH2 A/B/C/D матч — тоже) —
    // как в Ф1, доверяем детерминированному целиком.
    return { outcome: 'executing', method: 'auto', decided: toDecided(det.intents) }
  }

  if (ai.route === 'ai') {
    // rule 4: AI не смог определить символ (даже с контекстом OPEN_POSITIONS/reply/vision) —
    // шаблон авторитетнее, ничего не потеряно, доверяем детерминированному целиком.
    if (ai.reason === 'symbol_unknown_needs_vision') {
      return { outcome: 'executing', method: 'auto', decided: toDecided(det.intents) }
    }
    // rule 3 (обобщено): needs_human ЛИБО любая другая неоднозначность, которую AI не смог
    // разрешить, при УЖЕ совпавшем шаблоне — сигнал для ручной проверки, а не молчаливое
    // доверие шаблону (AI знает что-то, чего не знает regex — иначе зачем он вообще вызывался).
    return conflict(ctx, `AI поднял needs_review (reason=${ai.reason ?? 'unknown'}) при совпавшем шаблоне`)
  }

  // ai.route ∈ {'execute','skip','noise'} — сравниваем сигнатуры (symbol,side,type), rule 1/3.
  const aiSignatures = ai.intents.map(classifyIntent)
  const agreesAll = det.intents.every((intent) => {
    const d = classifyIntent(intent)
    return aiSignatures.some((a) => a.symbol === d.symbol && a.side === d.side && a.type === d.type)
  })

  if (!agreesAll) {
    return conflict(ctx, `AI дал другой symbol/side/type (ai.route=${ai.route})`)
  }
  // rule 1: согласие — числа берём из ДЕТЕРМИНИРОВАННОГО (regex надёжнее LLM на цифрах).
  return { outcome: 'executing', method: 'auto', decided: toDecided(det.intents) }
}

/** Шаблон НЕ совпал (deterministic.route==='ai') — §12 rule 2 + гейт §8/§11. */
function reconcileAiRoute(ai: ParsedResult | null, ctx: ReconcileContext): Decision {
  if (ai === null) {
    // ДЕГРАДАЦИЯ (research §11): ai-proxy недоступен после исчерпания ретраев пайплайном.
    // Сообщение НЕ теряется — needs_review, переобрабатываемо (см. p2-task4-report.md), 0 ордеров.
    console.error(`[reconciler] AI недоступен (канал ${ctx.channelId}) — сообщение уходит в needs_review, ai_unavailable`)
    return { outcome: 'needs_review', method: 'review', decided: [], reason: 'ai_unavailable' }
  }

  if (ai.route === 'noise') return { outcome: 'noise', method: null, decided: [] }

  if (ai.route === 'skip') {
    // Символ резолвлен AI, но не листингован (та же семантика, что и у детерминированного skip) —
    // источник решения целиком AI, поэтому Method='ai', а не 'auto'.
    return { outcome: 'skipped', method: 'ai', decided: [], reason: ai.reason ?? 'symbol_not_listed' }
  }

  if (ai.route === 'ai') {
    // needs_human / symbol UNKNOWN (без шаблонной подсказки) / неоднозначная семантика — AI сам
    // расписался, что не уверен; шаблона нет, довериться нечему → needs_review.
    return { outcome: 'needs_review', method: 'review', decided: [], reason: ai.reason ?? 'needs_human' }
  }

  // ai.route === 'execute': гейт уверенности (research §8/§11) — эскалация Sonnet→Opus уже
  // произошла (или не потребовалась) ДО вызова reconcile (пайплайн); здесь — финальная проверка
  // ПОСЛЕ эскалации, а не повторный вызов AI (заметка задачи 2: не зацикливаться).
  if (ai.confidence < AI_CONFIDENCE_GATE) {
    return { outcome: 'needs_review', method: 'review', decided: [], reason: 'low_confidence' }
  }

  // rule 2: шаблон не совпал — всё исполняем ИЗ AI (числа/символ/маркеры — всё оттуда).
  return { outcome: 'executing', method: 'ai', decided: toDecided(ai.intents) }
}

function conflict(ctx: ReconcileContext, detail: string): Decision {
  console.warn(`[reconciler] parser_disagreement (канал ${ctx.channelId}): ${detail}`)
  return { outcome: 'needs_review', method: 'review', decided: [], reason: 'parser_disagreement' }
}
