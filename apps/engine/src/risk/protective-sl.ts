// Защитный стоп для входа БЕЗ стопа («Long BTC, с текущих»).
//
// ЗАЧЕМ. Свободный текст сплошь и рядом не содержит стопа: «беру соль по рынку», «Long BTC с текущих».
// Войти на плече и не поставить стоп — прямой путь к ликвидации, поэтому позиция не должна ни секунды
// висеть без защиты. Политика channel_settings.no_sl_policy='attach_protective_sl' ровно про это:
// «входим сразу, ставим собственный страховочный SL, рассчитанный от дефолтного плеча; когда автор
// пришлёт свой стоп — заменяем» (design spec §8). Замена работает сама собой: авторский `sl_set`
// придёт дельтой и перезапишет стоп через setStopLoss.
//
// КАК. Не изобретаем новую величину, а ИНВЕРТИРУЕМ существующую формулу плеча (risk/leverage.ts):
//
//   computeLeverage:  lev = 1 / (d + mmr + buf)          где d = |entry − sl| / entry
//   инверсия:         d   = 1/lev − mmr − buf
//                     SL  = entry × (1 − d)   для long
//                     SL  = entry × (1 + d)   для short
//
// Смысл: берём плечо, которое канал и так себе назначил, и ставим стоп ровно там, где это плечо
// перестаёт быть безопасным — строго ПЕРЕД ликвидацией (буфер `buf` покрывает комиссии/проскальзывание).
// Инверсия точная: computeLeverage(entry, protectiveSl(entry, lev)) возвращает то же самое плечо,
// поэтому существующий гейт safeStop (SL должен быть раньше ликвидации) проходит по построению.
//
// Следствие, которое надо понимать: чем ВЫШЕ плечо, тем БЛИЖЕ стоп (при 10x → 9% от входа, при 20x →
// 4%). Это не «широкий стоп = плохо»: широкий стоп на малом плече рискует теми же деньгами, что узкий
// на большом. Меняется не риск, а вероятность быть выбитым шумом.

import { Decimal } from 'decimal.js'
import type { Side } from 'shared/domain.js'
import { floorTo, type Numeric } from './leverage.js'

/** ТОТ ЖЕ буфер, что DEFAULT_BUF в computeLeverage. Один буфер по обе стороны инверсии — иначе
 *  computeLeverage(protectiveSl(lev)) !== lev, и гейт safeStop начнёт врать. */
const DEFAULT_BUF = '0.005'

export interface LeverageWithoutSlParams {
  /** channel_settings.default_leverage — «плечо по умолчанию», когда стопа нет. */
  defaultLev: string | null
  channelMaxLev: Numeric
  instrMaxLev: Numeric
  leverageStep: Numeric
}

/**
 * Плечо для входа без стопа: берём `default_leverage` канала, а если он не задан — его же потолок
 * `max_leverage`. Клампим потолком инструмента и шагом плеча биржи.
 *
 * Без стопа вывести плечо из сигнала невозможно (стоп — единственный вход в формулу), поэтому его
 * задаёт оператор настройкой канала. Это и есть «дефолтное плечо» из спеки §8.
 */
export function leverageWithoutSl(params: LeverageWithoutSlParams): Decimal {
  const desired = params.defaultLev !== null ? new Decimal(params.defaultLev) : new Decimal(params.channelMaxLev)
  const capped = Decimal.min(desired, new Decimal(params.channelMaxLev), new Decimal(params.instrMaxLev))
  return Decimal.max(new Decimal(1), floorTo(params.leverageStep, capped))
}

export interface ProtectiveSlParams {
  entry: Numeric
  side: Side
  lev: Numeric
  /** Maintenance margin rate инструмента (instruments.mmr). */
  mmr: Numeric
  buf?: Numeric
}

/**
 * Защитный стоп — точная инверсия computeLeverage.
 *
 * `null` означает, что плечо СЛИШКОМ велико: `1/lev` не покрывает даже mmr+buf, то есть стоп
 * схлопнулся бы в саму цену ликвидации (например 100x при mmr=0.005). Ставить такой «стоп» нельзя —
 * он не защищает, а лишь имитирует защиту. Вызывающая сторона обязана пропустить вход
 * (skip 'unsafe_leverage'), а не входить без стопа.
 */
export function protectiveSl(params: ProtectiveSlParams): Decimal | null {
  const buf = params.buf === undefined ? new Decimal(DEFAULT_BUF) : new Decimal(params.buf)
  const d = new Decimal(1).div(params.lev).minus(params.mmr).minus(buf)
  if (d.lte(0)) return null

  const entry = new Decimal(params.entry)
  return params.side === 'long' ? entry.mul(new Decimal(1).minus(d)) : entry.mul(new Decimal(1).plus(d))
}
