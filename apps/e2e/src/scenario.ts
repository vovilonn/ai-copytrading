import { Decimal } from 'decimal.js'
import type { ChannelSlot } from './env.js'
import type { MessageTrace } from './db.js'
import type { PostSpec } from './tg.js'

/**
 * Язык сценариев e2e. Сознательно TypeScript, а не YAML/JSON: ожидания типизированы (опечатка в
 * статусе — ошибка компиляции, а не «зелёный» прогон), а текст поста может быть ФУНКЦИЕЙ от
 * живой цены — без этого почти каждый вход отбивался бы гейтом slippage (0.5%), ведь цена рынка
 * меняется между написанием сценария и прогоном.
 */

export interface StepContext {
  /** Живой mark price символа, округлённый к шагу цены инструмента. */
  mark(symbol: string): Promise<string>
  /** Цена, смещённая от mark на процент (знак = направление): offset('BTCUSDT', -3) — на 3% ниже. */
  offset(symbol: string, pct: number): Promise<string>
  /** tg_message_id поста шага по индексу (0-based); отрицательный индекс — от конца (-1 = предыдущий). */
  postedId(stepIndex: number): number
  /** Символы сценария — удобно в custom-проверках. */
  symbols: string[]
  /** Путь к файлу из apps/e2e/fixtures (картинки для медиа-сценариев). */
  fixture(name: string): string
  /**
   * Операционные вмешательства «мимо бота» — для сценариев, где проверяется реакция системы
   * на действия оператора (выключил копирование, закрыл позицию руками на бирже).
   */
  ops: {
    setCopyEnabled(enabled: boolean): Promise<void>
    /** Закрывает позицию символа рынком «руками оператора» — ордер НЕ от движка. */
    closeOnExchange(symbol: string): Promise<void>
  }
}

export type PostFactory = PostSpec | ((ctx: StepContext) => PostSpec | Promise<PostSpec>)

export interface ActionExpect {
  type?: string | string[]
  status?: string | string[]
  symbol?: string
  side?: 'long' | 'short'
  /** null — «причина пропуска должна отсутствовать»; строка/regexp — совпадение. */
  skipReason?: string | RegExp | null
  method?: string
}

export interface PositionExpect {
  symbol: string
  /** 'flat' — строки нет либо size=0. */
  side?: 'long' | 'short' | 'flat'
  size?: 'gt0' | 'zero'
  /** Стоп в зеркале позиции (positions.stop_loss) выставлен. */
  stopLossSet?: boolean
}

export interface ExchangeExpect {
  symbol: string
  /** Позиция на бирже: сторона либо её отсутствие. */
  position?: 'long' | 'short' | 'flat'
  /** У позиции на бирже стоит stopLoss (не пустая строка/не 0). */
  stopLoss?: boolean
  /** Живые ордера символа (reduceOnly-лимитки TP и т.п.). */
  openOrdersMin?: number
  openOrdersMax?: number
}

export interface OrderExpect {
  purpose: string
  count?: number
  minCount?: number
  status?: string | string[]
}

export interface StepExpect {
  /** messages.status после обработки. */
  status?: string | string[]
  /** messages.status_reason. */
  reason?: string | RegExp | null
  /** messages.method — 'auto' | 'ai' | 'review'. */
  method?: string
  /** Действия по порядку action_index; лишние действия сверх списка — ошибка. */
  actions?: ActionExpect[]
  /** Строки orders, сгруппированные по purpose. */
  orders?: OrderExpect[]
  /** Зеркало позиции в БД. */
  position?: PositionExpect
  /** Живое состояние Bybit. */
  exchange?: ExchangeExpect
  /** Свободная проверка: возвращает список проблем (пустой список = всё хорошо). */
  custom?: (trace: MessageTrace, ctx: StepContext) => string[] | Promise<string[]>
}

export interface Step {
  title: string
  /** Пост в тестовый канал. Отсутствует — шаг только проверяет/действует (см. `act`). */
  post?: PostFactory
  /** Правка ранее отправленного поста: { step: индекс шага, text }. */
  edit?: { step: number; text: string }
  /** Удаление ранее отправленного поста (ветка DeletedMessage в tg-ingest). */
  deletePost?: { step: number }
  /** Подготовка шага — выполняется ДО поста (напр. оператор снял тумблер копирования,
   *  закрыл позицию руками на бирже). */
  act?: (ctx: StepContext) => Promise<void>
  expect?: StepExpect
  /** Сколько ждать выполнения ожиданий после терминального статуса (дефолт 25 с). */
  settleMs?: number
  /** Пауза перед постом — для сценариев, где важен зазор по времени. */
  delayBeforeMs?: number
}

export interface Scenario {
  id: string
  title: string
  /** 1 = ch1-structured (regex), 2 = ch2-freeform (AI). */
  slot: ChannelSlot
  /** Символы, которых касается сценарий — снапшот/выравнивание биржи делаются по ним. */
  symbols: string[]
  tags?: string[]
  /** Короткое пояснение «что именно проверяем» — попадает в отчёт. */
  note?: string
  /**
   * Сценарий проверяет события, которые приходят ТОЛЬКО реалтаймом (правка/удаление поста):
   * бэкфилл их не догоняет — он читает сообщения строго новее курсора, а правка приходит на
   * старый id. Пока постер делит сессию с воркером (нет E2E_TG_SESSION), realtime не работает,
   * и такой сценарий честно помечается пропущенным вместо ложного провала.
   */
  requiresRealtime?: boolean
  steps: Step[]
}

/** Округление цены к шагу инструмента с сохранением его точности ('0.01' -> '111234.50'). */
export function roundToTick(price: Decimal.Value, tickSize: string): string {
  const tick = new Decimal(tickSize)
  const rounded = new Decimal(price).div(tick).round().mul(tick)
  return rounded.toFixed(tick.decimalPlaces())
}
