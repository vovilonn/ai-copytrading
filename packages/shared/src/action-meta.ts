// Единая таблица "тип действия -> иконка/подпись" (задача 8, спека §12) — общий источник для
// apps/api/src/actions/actions.service.ts (таблица Actions) и apps/api/src/channels/channels.service.ts
// (иконка в таймлайне сообщений, MessageActionDto.icon), чтобы маппинг не дублировался в двух
// сервисах. Иконки — только lucide-react (design/project/lucide-icon.js), имена см. там же.
import type { ActionType, Side } from './domain.js'

export interface ActionMeta {
  /** Короткая подпись типа для колонки "Action" (design/project/Admin.dc.html: const A). */
  short: string
  /** Полное описание для Summary/detail (design: a.title), без суффикса ` · pct%` — его
   *  добавляет actionSummary() ниже. */
  title: string
  /** lucide-имя по умолчанию — для 'open' переопределяется по стороне, см. actionIcon(). */
  icon: string
}

// Дословно спека §12 + design/project/Admin.dc.html (const A, строки 508-513) для 4 типов,
// которые рисует прототип; остальные 8 типов backend-only (спека: "Бэкенд знает 12 типов,
// прототип рисует 4") — для них короткая подпись/иконка подобраны по той же логике
// (close_all — тот же круг-крест, что и close; modify_tp — та же мишень, что и partial_tp/tp_hit;
// tp_hit/sl_hit в проекте задуманы как строка саммари, а не действие таблицы Actions, — но раз
// actions.type допускает эти значения в БД (миграция 001_initial.ts), строка таблицы для них
// всё равно должна на что-то рендериться, а не падать на необработанном case).
export const ACTION_META: Readonly<Record<ActionType, ActionMeta>> = {
  open: { short: 'Open', title: 'Open position', icon: 'circle-plus' }, // icon переопределяется по side в actionIcon()
  add: { short: 'Add', title: 'Add to position', icon: 'circle-plus' },
  close: { short: 'Close', title: 'Close position', icon: 'circle-x' },
  close_all: { short: 'Close all', title: 'Close all positions', icon: 'circle-x' },
  partial_tp: { short: 'Partial TP', title: 'Partial take-profit', icon: 'target' },
  partial_close: { short: 'Partial close', title: 'Partial close', icon: 'scissors' },
  modify_sl: { short: 'Modify SL', title: 'Stop-loss updated', icon: 'shield' },
  modify_tp: { short: 'Modify TP', title: 'Take-profit updated', icon: 'target' },
  cancel_order: { short: 'Cancel order', title: 'Order cancelled', icon: 'circle-minus' },
  tp_hit: { short: 'TP hit', title: 'Take-profit hit', icon: 'target' },
  sl_hit: { short: 'SL hit', title: 'Stop-loss hit', icon: 'shield' },
  hold: { short: 'Hold', title: 'Position held', icon: 'circle-minus' },
} as const

/** Полный список ActionType в рантайме (нет смысла хардкодить second раз для валидации query-параметров). */
export const ACTION_TYPES: readonly ActionType[] = Object.keys(ACTION_META) as ActionType[]

/**
 * Иконка типа action (спека §12, design: `actIco`): у 'open' иконка/цвет зависят от стороны
 * (long/short), у остальных типов — фиксированные из ACTION_META. side===null у 'open' — это
 * ТОЛЬКО синтетическая "весь месседж пропущен" заглушка (pipeline.ts: ensureWholeMessageSkipped),
 * сторону сигнала в ней восстановить нечем — берём trending-up дефолтом (лучше стабильная
 * заглушка, чем падение маппинга).
 */
export function actionIcon(type: ActionType, side: Side | null): string {
  if (type === 'open') return side === 'short' ? 'trending-down' : 'trending-up'
  return ACTION_META[type].icon
}

/** Цвет иконки (design: `actAccent`/`dcol`) — цветной только 'open' по стороне, остальные типы
 *  нейтральны (буквально так в прототипе: `accent = type==='open' ? dcol(dir) : null`). */
export function actionIconColor(type: ActionType, side: Side | null): string {
  if (type === 'open' && side !== null) return side === 'long' ? '#34d399' : '#fb7185'
  return '#e5e5e5'
}

/** Summary-строка таблицы Actions (design: `a.title + pctSuffix`). pct — строка NUMERIC(6,3)
 *  вида '50.000', суффикс печатается без незначащих нулей ("· 50%"), а не "· 50.000%". */
/**
 * Подпись действия для оператора.
 *
 * `placedOrders` — краткая сводка ордеров, которые это действие реально отправило на биржу
 * («tp 1943, sl 1910»). Одно действие несёт НЕСКОЛЬКО операций, а его тип выбирается по
 * приоритету: сообщение «стопы в безубыток + первый тейк 1943» показывалось как «Stop-loss
 * updated», и было не понять, выставлен ли тейк (живой случай 28.07.2026).
 */
export function actionSummary(type: ActionType, pct: string | null, placedOrders?: string | null): string {
  const title = ACTION_META[type].title
  const withPct = pct === null ? title : `${title} · ${String(Number(pct))}%`
  return placedOrders ? `${withPct} · ${placedOrders}` : withPct
}
