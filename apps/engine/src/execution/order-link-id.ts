/**
 * Ключ идемпотентности Bybit (research bybit-execution.md §8; design spec §9):
 *   orderLinkId ≤36 символов, алфавит [A-Za-z0-9_-], должен быть уникален для всех типов ордеров.
 *   Дубликат → retCode 110072 ("OrderLinkedID is duplicate") — трактуется вызывающей стороной
 *   как идемпотентный успех (см. task-5-brief.md, задачи исполнения).
 *
 * КЛЮЧЕВОЕ РЕШЕНИЕ (LOOP_STATE.md): orderLinkId строится из координат СООБЩЕНИЯ
 * (channelOrd, tgMessageId, actionIndex, purpose, legIndex), а НЕ из tradeId/orderId —
 * потому что tradeId создаётся ДО отправки ордера на биржу; краш процесса между отправкой
 * ордера и персистом его в БД дал бы дубль-ордер при ретрае (у tradeId после рестарта не было
 * бы способа обнаружить, что ордер уже ушёл). Координаты сообщения детерминированы и известны
 * ДО любого обращения к БД/бирже — ретрай/реконнект после краша реконструирует ТОТ ЖЕ ключ.
 */

import type { OrderPurpose } from 'shared/domain.js'

// OrderPurpose переиспользован из shared/domain.ts (тот же enum order_purpose схемы,
// единый источник правды для api/database.ts и engine/execution/port.ts — задача 6).
export type { OrderPurpose }

export type ExecutionMode = 'dry_run' | 'live'

export interface OrderLinkIdParams {
  mode: ExecutionMode
  /** channels.ord (1, 2, ...) — ординал канала, форматируется 2 цифрами (01, 02). */
  channelOrd: number
  /** Telegram message id сообщения-источника действия. */
  tgMessageId: number
  /** Индекс действия внутри сообщения (несколько ордеров в одном сообщении — "2 limit long" и т.п.). */
  actionIndex: number
  purpose: OrderPurpose
  /**
   * Чистая функция самого сообщения: для TP — индекс цели в tps[] сообщения, для входа/добора —
   * всегда 0. НИКОГДА не выводить из числа уже существующих в БД лег/ордеров — это сделало бы
   * ключ зависимым от порядка обработки и сломало бы идемпотентность при ретрае.
   */
  legIndex: number
}

// Однобуквенный код purpose (§8: часть ключа после `-`, перед legIndex). Первая буква
// английского имени, кроме sl->S (e уже занята entry) и cancel->X (c уже занята close).
const PURPOSE_CODE: Readonly<Record<OrderPurpose, string>> = {
  entry: 'E',
  add: 'A',
  tp: 'T',
  sl: 'S',
  close: 'C',
  cancel: 'X',
}

const MODE_PREFIX: Readonly<Record<ExecutionMode, string>> = {
  dry_run: 'D',
  live: 'K',
}

const VALID_CHARS_RE = /^[A-Za-z0-9_-]+$/
const MAX_LEN = 36

/**
 * Форма ключа, порождённого ЭТИМ движком: `<K|D><ord2>-<tgMessageId>-<idx2>-<purpose><leg>`
 * (см. orderLinkId ниже). Держится рядом с генератором намеренно: любой правкой формата ключа
 * ломается и распознавание — пусть ломается в одном файле.
 */
// `\d{2,}` — не ровно две цифры: pad2 добивает НУЛЯМИ ДО двух, но не режет длиннее (ord
// тестовых каналов = 101, см. shared/sources.ts::OVERRIDE_ORD_OFFSET).
const ENGINE_LINK_ID_RE = new RegExp(
  `^[${Object.values(MODE_PREFIX).join('')}]\\d{2,}-\\d+-\\d{2,}-[${Object.values(PURPOSE_CODE).join('')}]\\d+$`,
)

/**
 * Наш ли это ключ идемпотентности.
 *
 * Нужен атрибуции исполнений (bybit/sync/attribute.ts): пуш филла прилетает по WS за миллисекунды,
 * а строка `orders` коммитится транзакцией пайплайна чуть позже — лукап по order_link_id в этот
 * момент промахивается. Без признака «ключ всё-таки НАШ» такой промах уводил исполнение в ветку
 * «ручное действие оператора», и живой сделке проставлялся manual_override, после чего канал
 * переставал двигать её стоп. Форма ключа детерминирована и чужими ордерами не воспроизводится.
 */
export function isEngineOrderLinkId(orderLinkId: string | null | undefined): boolean {
  if (!orderLinkId) return false
  return ENGINE_LINK_ID_RE.test(orderLinkId)
}

function nonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`orderLinkId: ${label} должен быть неотрицательным целым, получено ${String(value)}`)
  }
  return value
}

/** Дополняет неотрицательное целое до 2 цифр слева нулём (01, 02, ..., 99, 100...). */
function pad2(value: number, label: string): string {
  return String(nonNegativeInt(value, label)).padStart(2, '0')
}

/**
 * orderLinkId = <D|K><channelOrd:2><tgMessageId>-<actionIndex:2>-<purpose><legIndex>
 * Пример: orderLinkId({mode:'dry_run', channelOrd:2, tgMessageId:221452, actionIndex:0,
 *          purpose:'entry', legIndex:0}) -> 'D02-221452-00-E0'
 */
export function orderLinkId(params: OrderLinkIdParams): string {
  const prefix = MODE_PREFIX[params.mode]
  const purposeCode = PURPOSE_CODE[params.purpose]
  if (prefix === undefined) throw new Error(`orderLinkId: неизвестный mode ${String(params.mode)}`)
  if (purposeCode === undefined) throw new Error(`orderLinkId: неизвестный purpose ${String(params.purpose)}`)

  const ord = pad2(params.channelOrd, 'channelOrd')
  const tgMessageId = nonNegativeInt(params.tgMessageId, 'tgMessageId')
  const actionIndex = pad2(params.actionIndex, 'actionIndex')
  const legIndex = nonNegativeInt(params.legIndex, 'legIndex')

  const key = `${prefix}${ord}-${tgMessageId}-${actionIndex}-${purposeCode}${legIndex}`

  // Защитная проверка инварианта биржи — идемпотентность денег держится на этом ключе,
  // тихо пропустить нарушение (слишком длинный tgMessageId и т.п.) недопустимо.
  if (key.length > MAX_LEN) {
    throw new Error(`orderLinkId превышает ${MAX_LEN} символов (${key.length}): ${key}`)
  }
  if (!VALID_CHARS_RE.test(key)) {
    throw new Error(`orderLinkId содержит недопустимые символы: ${key}`)
  }

  return key
}

/**
 * Индекс ноги для цели TP-лесенки: номер лесенки внутри action + индекс самой цели.
 *
 * Два `tp_set` в одном сообщении («первая цель 1943 … и сразу вторая 1960») иначе дали бы
 * одинаковый ключ на цель с тем же индексом — Bybit отвергает дубликат (110072), транзакция
 * откатывается, и сообщение переигрывается каждые 5 секунд. Шаг в 10 позиций: больше десяти
 * целей в одной лесенке не бывает, а формат ключа при `tpSeq=0` не меняется вовсе (0*10+index),
 * то есть уже обработанные сообщения остаются идемпотентными.
 */
export function tpLegIndex(tpSeq: number | undefined, targetIndex: number): number {
  return (tpSeq ?? 0) * 10 + targetIndex
}
