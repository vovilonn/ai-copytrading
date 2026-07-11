import {
  CircleMinus,
  CirclePlus,
  CircleX,
  Scissors,
  Shield,
  Target,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'

// Общий для ActionsPage (routes/actions.tsx) и MessageTimeline (components/MessageTimeline.tsx)
// маппинг lucide-имени (shared/action-meta.ts: actionIcon()) на React-компонент — вынесен сюда,
// чтобы не дублировать один и тот же литерал в двух местах (task-11-brief.md, приёмка Ф1:
// таймлайн канала теперь тоже рисует action-строки под сообщениями, тем же набором иконок,
// что и таблица Actions).
const ACTION_ICONS: Record<string, LucideIcon> = {
  'circle-plus': CirclePlus,
  'circle-x': CircleX,
  target: Target,
  scissors: Scissors,
  shield: Shield,
  'circle-minus': CircleMinus,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
}

/** Иконка по lucide-имени из backend (MessageActionDto.icon/ActionRowDto.icon) — CircleMinus,
 *  если backend когда-нибудь пришлёт имя вне маппинга (защитный дефолт, не падение рендера). */
export function getActionIcon(icon: string): LucideIcon {
  return ACTION_ICONS[icon] ?? CircleMinus
}

// Бриф: "tradeRef приходит уже с # или без — проверь и приведи к виду #TR-1042". Бэкенд
// (actions.service.ts/channels.service.ts: `#${row.human_ref}`) сейчас всегда сам добавляет '#' —
// проверка здесь идемпотентна и не полагается молча на то, что так будет всегда.
export function normalizeTradeRef(ref: string): string {
  return ref.startsWith('#') ? ref : `#${ref}`
}

// Task 6 (Ф2, task-6-brief.md): причины, которыми reconciler (apps/engine/src/reconciler.ts)
// помечает исход needs_review (а не обычный business-skip вроде symbol_busy/no_sl) —
// 'parser_disagreement' (rule 3: детерминированный/AI разбор разошлись), 'ai_unavailable'
// (деградация ai-proxy), 'low_confidence' (гейт §8/§11), 'needs_human' (дефолт-фолбэк AI-причины).
// Список вынесен сюда, а не в shared/ — задача работает только в apps/web, skipReason в DTO
// сейчас просто `string | null`, разбор смысла причины — забота фронта этой задачи.
const NEEDS_REVIEW_REASONS: ReadonlySet<string> = new Set([
  'parser_disagreement',
  'ai_unavailable',
  'needs_human',
  'low_confidence',
])

/** true, если skipReason — один из "требует ручной проверки" исходов реконсилера (needs_review):
 *  бейдж должен показать текст "Needs review", а не "Skipped" (тот же skipped-стиль, design). */
export function isNeedsReviewReason(reason: string | null): boolean {
  return reason !== null && NEEDS_REVIEW_REASONS.has(reason)
}
