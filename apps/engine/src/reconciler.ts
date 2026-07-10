import type { ParsedIntent, ParsedResult } from 'shared/domain.js'

/**
 * Reconciler (design spec §6, task-7-brief.md) — сливает вывод парсера (в Ф2 — и AI) в единое
 * решение о судьбе СООБЩЕНИЯ и назначает КАНОНИЧЕСКИЙ `actionIndex` каждому intent. В Ф1 путь
 * только детерминированный: `route==='execute'` → исполнять; `'ai'` → `needs_review` (AI — Ф2,
 * см. adapters/registry.ts — ch2Stub всегда отдаёт `ai` с пустыми intents); `'noise'` → `noise`;
 * `'skip'` → `skipped` с причиной парсера.
 *
 * `actionIndex` — позиция intent'а в массиве `parsed.intents`, ровно как его отдал адаптер.
 * Стабильно и детерминированно, ПОКА адаптер — чистая функция одного и того же текста
 * сообщения (ch1.adapter.ts таков) — повторный разбор того же сообщения даёт тот же массив
 * intents в том же порядке, значит и тот же actionIndex на каждый intent. Это ровно то, что
 * требует идемпотентность orderLinkId ниже по пайплайну (order-link-id.ts).
 */

export type MessageOutcome = 'executing' | 'needs_review' | 'skipped' | 'noise'

export interface DecidedIntent {
  readonly actionIndex: number
  readonly intent: ParsedIntent
}

export interface Decision {
  readonly outcome: MessageOutcome
  /** 'auto' — решение целиком от детерминированного парсера (design spec §6, поле Method в UI). */
  readonly method: 'auto' | null
  readonly decided: readonly DecidedIntent[]
  /** Причина для outcome==='skipped' — сообщение отвергнуто ЦЕЛИКОМ, ещё до появления intent'ов
   *  (ParsedResult.reason: 'no_SL' | 'symbol_unknown' | 'symbol_not_listed' | 'incomplete_signal'). */
  readonly skipReason?: string
}

/**
 * Контекст реконсиляции. В Ф1 не используется телом функции (реконсиляция — чистое отображение
 * route→outcome), но зарезервирован под Ф2: там появится второй параллельный путь (AI), и сюда
 * же придёт его результат для слияния (design spec §6: "расхождение по числу действий или по
 * символу → needs_review"). channelId уже прокинут для будущего логирования конфликтов det/ai.
 */
export interface ReconcileContext {
  readonly channelId: number
}

export function reconcile(parsed: ParsedResult, _ctx: ReconcileContext): Decision {
  switch (parsed.route) {
    case 'noise':
      return { outcome: 'noise', method: null, decided: [] }
    case 'ai':
      // Ф1: AI-слой ещё не подключён — сообщение ждёт человека/AI (Ф2), ничего не исполняем.
      return { outcome: 'needs_review', method: null, decided: [] }
    case 'skip':
      return { outcome: 'skipped', method: 'auto', decided: [], skipReason: parsed.reason ?? 'skip' }
    case 'execute':
      return {
        outcome: 'executing',
        method: 'auto',
        decided: parsed.intents.map((intent, actionIndex) => ({ actionIndex, intent })),
      }
  }
}
