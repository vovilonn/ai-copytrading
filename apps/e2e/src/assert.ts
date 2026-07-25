import { Decimal } from 'decimal.js'
import type { Order, Position } from 'engine/bybit/rest-client.js'
import type { ActionRow, MessageTrace, OrderRow, PositionRow } from './db.js'
import type { ActionExpect, ExchangeExpect, OrderExpect, PositionExpect, StepExpect } from './scenario.js'

/**
 * Сверка ожиданий шага с фактом. Каждая функция возвращает СПИСОК проблем (пустой = совпало) —
 * а не бросает: шаг должен показать сразу все расхождения, а не первое; и раннер вызывает эти
 * же функции в цикле ожидания, где несовпадение — нормальное промежуточное состояние.
 */

type Expected = string | string[] | undefined

function matches(actual: string | null, expected: Expected): boolean {
  if (expected === undefined) return true
  const list = Array.isArray(expected) ? expected : [expected]
  return actual !== null && list.includes(actual)
}

function show(expected: Expected): string {
  return Array.isArray(expected) ? expected.join('|') : String(expected)
}

function matchesReason(actual: string | null, expected: string | RegExp | null | undefined): boolean {
  if (expected === undefined) return true
  if (expected === null) return actual === null
  if (expected instanceof RegExp) return actual !== null && expected.test(actual)
  return actual === expected
}

export function checkMessage(expect: StepExpect, trace: MessageTrace): string[] {
  const problems: string[] = []
  const { message } = trace
  if (!matches(message.status, expect.status)) {
    problems.push(`статус сообщения: ожидали ${show(expect.status)}, получили '${message.status}'`)
  }
  if (!matchesReason(message.statusReason, expect.reason)) {
    problems.push(`причина (status_reason): ожидали ${expect.reason === null ? 'отсутствие' : String(expect.reason)}, получили ${message.statusReason === null ? 'null' : `'${message.statusReason}'`}`)
  }
  if (!matches(message.method, expect.method)) {
    problems.push(`метод разбора: ожидали ${show(expect.method)}, получили ${message.method === null ? 'null' : `'${message.method}'`}`)
  }
  return problems
}

export function checkActions(expected: ActionExpect[] | undefined, actions: ActionRow[]): string[] {
  if (expected === undefined) return []
  const problems: string[] = []
  if (actions.length !== expected.length) {
    problems.push(
      `число действий: ожидали ${expected.length}, получили ${actions.length} [${actions.map((a) => `${a.type}/${a.status}${a.symbol ? ` ${a.symbol}` : ''}`).join(', ')}]`,
    )
  }
  expected.forEach((exp, index) => {
    const actual = actions[index]
    if (!actual) {
      problems.push(`действие #${index}: ожидали ${show(exp.type) ?? 'любое'}, но действия нет`)
      return
    }
    const where = `действие #${index}`
    if (!matches(actual.type, exp.type)) problems.push(`${where}: тип ожидали ${show(exp.type)}, получили '${actual.type}'`)
    if (!matches(actual.status, exp.status)) problems.push(`${where}: статус ожидали ${show(exp.status)}, получили '${actual.status}'`)
    if (exp.symbol !== undefined && actual.symbol !== exp.symbol) {
      problems.push(`${where}: символ ожидали '${exp.symbol}', получили ${actual.symbol === null ? 'null' : `'${actual.symbol}'`}`)
    }
    if (exp.side !== undefined && actual.side !== exp.side) {
      problems.push(`${where}: сторона ожидали '${exp.side}', получили ${actual.side === null ? 'null' : `'${actual.side}'`}`)
    }
    if (!matchesReason(actual.skipReason, exp.skipReason)) {
      problems.push(
        `${where}: skip_reason ожидали ${exp.skipReason === null ? 'отсутствие' : String(exp.skipReason)}, получили ${actual.skipReason === null ? 'null' : `'${actual.skipReason}'`}`,
      )
    }
    if (!matches(actual.method, exp.method)) problems.push(`${where}: method ожидали ${show(exp.method)}, получили '${actual.method}'`)
  })
  return problems
}

export function checkOrders(expected: OrderExpect[] | undefined, orders: OrderRow[]): string[] {
  if (expected === undefined) return []
  const problems: string[] = []
  for (const exp of expected) {
    const matching = orders.filter((o) => o.purpose === exp.purpose && matches(o.status, exp.status))
    const label = `ордера purpose='${exp.purpose}'${exp.status ? ` status=${show(exp.status)}` : ''}`
    if (exp.count !== undefined && matching.length !== exp.count) {
      problems.push(`${label}: ожидали ${exp.count}, получили ${matching.length}`)
    }
    if (exp.minCount !== undefined && matching.length < exp.minCount) {
      problems.push(`${label}: ожидали не меньше ${exp.minCount}, получили ${matching.length}`)
    }
  }
  return problems
}

export function checkPosition(expected: PositionExpect | undefined, positions: PositionRow[]): string[] {
  if (expected === undefined) return []
  const problems: string[] = []
  const row = positions.find((p) => p.symbol === expected.symbol)
  const size = new Decimal(row?.size ?? '0')

  if (expected.side === 'flat') {
    if (size.gt(0)) problems.push(`позиция в БД ${expected.symbol}: ожидали пусто, получили size=${row?.size} side=${row?.side}`)
  } else if (expected.side !== undefined) {
    if (!row || row.side !== expected.side || size.lte(0)) {
      problems.push(
        `позиция в БД ${expected.symbol}: ожидали ${expected.side} с size>0, получили ${row ? `${row.side} size=${row.size}` : 'строки нет'}`,
      )
    }
  }
  if (expected.size === 'gt0' && size.lte(0)) {
    problems.push(`позиция в БД ${expected.symbol}: ожидали size>0, получили ${row?.size ?? 'строки нет'}`)
  }
  if (expected.size === 'zero' && size.gt(0)) {
    problems.push(`позиция в БД ${expected.symbol}: ожидали size=0, получили ${row?.size}`)
  }
  if (expected.stopLossSet !== undefined) {
    const hasSl = row?.stopLoss != null && new Decimal(row.stopLoss).gt(0)
    if (hasSl !== expected.stopLossSet) {
      problems.push(`позиция в БД ${expected.symbol}: стоп ${expected.stopLossSet ? 'ожидали' : 'не ожидали'}, в зеркале ${row?.stopLoss ?? 'null'}`)
    }
  }
  return problems
}

export function checkExchange(
  expected: ExchangeExpect | undefined,
  position: Position | null,
  orders: Order[],
): string[] {
  if (expected === undefined) return []
  const problems: string[] = []
  const size = new Decimal(position?.size ?? '0')

  if (expected.position === 'flat') {
    if (size.gt(0)) problems.push(`биржа ${expected.symbol}: ожидали отсутствие позиции, получили ${position?.side} size=${position?.size}`)
  } else if (expected.position !== undefined) {
    const wantSide = expected.position === 'long' ? 'Buy' : 'Sell'
    if (!position || size.lte(0) || position.side !== wantSide) {
      problems.push(
        `биржа ${expected.symbol}: ожидали ${expected.position} (${wantSide}) с size>0, получили ${position ? `${position.side} size=${position.size}` : 'позиции нет'}`,
      )
    }
  }
  if (expected.stopLoss !== undefined) {
    const hasSl = position !== null && position.stopLoss !== '' && new Decimal(position.stopLoss || '0').gt(0)
    if (hasSl !== expected.stopLoss) {
      problems.push(`биржа ${expected.symbol}: стоп ${expected.stopLoss ? 'ожидали' : 'не ожидали'}, у позиции stopLoss='${position?.stopLoss ?? ''}'`)
    }
  }
  const symbolOrders = orders.filter((o) => o.symbol === expected.symbol)
  if (expected.openOrdersMin !== undefined && symbolOrders.length < expected.openOrdersMin) {
    problems.push(`биржа ${expected.symbol}: живых ордеров ожидали не меньше ${expected.openOrdersMin}, получили ${symbolOrders.length}`)
  }
  if (expected.openOrdersMax !== undefined && symbolOrders.length > expected.openOrdersMax) {
    problems.push(`биржа ${expected.symbol}: живых ордеров ожидали не больше ${expected.openOrdersMax}, получили ${symbolOrders.length}`)
  }
  return problems
}
