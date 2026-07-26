import { fileURLToPath } from 'node:url'
import { Decimal } from 'decimal.js'
import type { Kysely } from 'kysely'
import type { DB } from 'api/db/database.js'
import type { BybitRestClient, Order, Position } from 'engine/bybit/rest-client.js'
import { channelBySlot, type E2eConfig } from './env.js'
import { findMessage, instrument, positionsOf, trace as traceMessage, tradesOf, waitForProcessed, type MessageTrace } from './db.js'
import { flatten, markPrice, openOrdersOf, positionOf } from './exchange.js'
import { TgPoster, type PostSpec } from './tg.js'
import { checkActions, checkExchange, checkMessage, checkOrders, checkPosition } from './assert.js'
import { nudgeIngest } from './nudge.js'
import { roundToTick, type Scenario, type Step, type StepContext } from './scenario.js'

/**
 * Прогон сценариев: пост в тестовый канал → ожидание, пока движок доведёт сообщение до
 * терминального статуса → сверка ожиданий по БД и по бирже → результат шага.
 *
 * Два разных ожидания, и их важно не путать:
 *  1) СТАТУС сообщения — детерминированный сигнал «пайплайн отработал» (waitForProcessed);
 *  2) ЭФФЕКТ на бирже — асинхронный: ордер уходит внутри обработки, но филл/позиция приезжают
 *     приватным WS спустя доли секунды. Поэтому ожидания шага проверяются В ЦИКЛЕ до settleMs,
 *     а не один раз сразу после смены статуса — иначе тесты флейкали бы на ровном месте.
 */

export interface RunnerOptions {
  /** Ждать терминального статуса сообщения (дефолт 120 с — AI-ветка ch2 может думать долго). */
  processTimeoutMs?: number
  /** Ждать выполнения ожиданий шага после терминального статуса (дефолт 25 с). */
  settleMs?: number
  /** Через сколько считать, что пост «залип», и толкнуть воркер (только при общей сессии). */
  nudgeAfterMs?: number
  /** Печатать ход прогона в консоль. */
  verbose?: boolean
}

export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped'

export interface StepResult {
  index: number
  title: string
  status: StepStatus
  problems: string[]
  /** Заметки инфраструктуры (не провал шага): напр. потребовался рестарт воркера. */
  notes: string[]
  error?: string
  postedIds: number[]
  postedText?: string
  durationMs: number
  trace?: MessageTrace
  exchange?: { symbol: string; position: Position | null; orders: Order[] }
}

export interface ScenarioResult {
  id: string
  title: string
  slot: number
  symbols: string[]
  tags: string[]
  note?: string
  status: 'passed' | 'failed' | 'error' | 'skipped'
  durationMs: number
  steps: StepResult[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface RunnerDeps {
  config: E2eConfig
  db: Kysely<DB>
  rest: BybitRestClient
  poster: TgPoster
}

export class ScenarioRunner {
  constructor(
    private readonly deps: RunnerDeps,
    private readonly options: RunnerOptions = {},
  ) {}

  async run(scenario: Scenario): Promise<ScenarioResult> {
    const startedAt = Date.now()
    const channel = channelBySlot(this.deps.config, scenario.slot)
    const postedByStep = new Map<number, number[]>()
    const results: StepResult[] = []
    let aborted = false

    this.log(`\n▶ ${scenario.id} — ${scenario.title} (канал ${scenario.slot}: ${channel.adapterId})`)

    // Правка/удаление приходят только реалтаймом, а он не работает, пока постер делит сессию с
    // воркером (см. tg.ts). Провалить такой сценарий значило бы соврать: проверка не выполнена,
    // а не сломана.
    if (scenario.requiresRealtime === true && this.deps.poster.sharesWorkerSession) {
      const reason = 'нужен realtime: заведите отдельную сессию постера (`pnpm e2e session`)'
      this.log(`  – пропущен: ${reason}`)
      return {
        id: scenario.id,
        title: scenario.title,
        slot: scenario.slot,
        symbols: scenario.symbols,
        tags: scenario.tags ?? [],
        ...(scenario.note !== undefined ? { note: scenario.note } : {}),
        status: 'skipped',
        durationMs: 0,
        steps: scenario.steps.map((step, index) => ({
          index,
          title: step.title,
          status: 'skipped' as const,
          problems: [],
          notes: [reason],
          postedIds: [],
          durationMs: 0,
        })),
      }
    }

    for (const [index, step] of scenario.steps.entries()) {
      if (aborted) {
        results.push({ index, title: step.title, status: 'skipped', problems: [], notes: [], postedIds: [], durationMs: 0 })
        continue
      }
      // Канал шага: сценарии про несколько каналов сразу (субаккаунты) публикуют шаги в разные
      // каналы, поэтому и пост, и проверки шага идут по ЕГО каналу, а не по каналу сценария.
      const stepChannel = step.slot === undefined ? channel : channelBySlot(this.deps.config, step.slot)
      const result = await this.runStep(scenario, stepChannel.id, step, index, postedByStep)
      results.push(result)
      // Сорванный шаг делает последующие бессмысленными: состояние сделки уже не то, которое
      // они предполагают (шаг «двигаем стоп» после несостоявшегося входа проверял бы пустоту).
      if (result.status === 'error' || result.status === 'failed') aborted = true
    }

    const status: ScenarioResult['status'] = results.some((r) => r.status === 'error')
      ? 'error'
      : results.some((r) => r.status === 'failed')
        ? 'failed'
        : 'passed'

    return {
      id: scenario.id,
      title: scenario.title,
      slot: scenario.slot,
      symbols: scenario.symbols,
      tags: scenario.tags ?? [],
      ...(scenario.note !== undefined ? { note: scenario.note } : {}),
      status,
      durationMs: Date.now() - startedAt,
      steps: results,
    }
  }

  private async runStep(
    scenario: Scenario,
    channelId: number,
    step: Step,
    index: number,
    postedByStep: Map<number, number[]>,
  ): Promise<StepResult> {
    const startedAt = Date.now()
    const ctx = this.buildContext(scenario, postedByStep, index)
    const base: StepResult = { index, title: step.title, status: 'passed', problems: [], notes: [], postedIds: [], durationMs: 0 }

    try {
      if (step.delayBeforeMs) await sleep(step.delayBeforeMs)
      // `act` — ПОДГОТОВКА шага, поэтому строго ДО поста: сценарий «выключенное копирование»
      // обязан успеть снять тумблер раньше, чем движок увидит сообщение (иначе гонка: сигнал
      // мог бы исполниться по старой настройке).
      if (step.act) await step.act(ctx)

      let anchorId: number | null = null
      let expectedText: string | null = null

      if (step.post) {
        const spec: PostSpec = typeof step.post === 'function' ? await step.post(ctx) : step.post
        const posted = await this.deps.poster.post(step.slot ?? scenario.slot, spec)
        postedByStep.set(index, posted.ids)
        base.postedIds = posted.ids
        if (spec.text !== undefined) base.postedText = spec.text
        anchorId = posted.anchorId
        this.log(`  · шаг ${index + 1}. ${step.title} → пост #${posted.anchorId}`)
      } else if (step.edit) {
        const targetIds = postedByStep.get(step.edit.step)
        if (!targetIds || targetIds.length === 0) throw new Error(`шаг ${index}: нет поста шага ${step.edit.step} для правки`)
        anchorId = targetIds[0]!
        await this.deps.poster.edit(step.slot ?? scenario.slot, anchorId, step.edit.text)
        expectedText = step.edit.text
        base.postedIds = [anchorId]
        base.postedText = step.edit.text
        this.log(`  · шаг ${index + 1}. ${step.title} → правка #${anchorId}`)
      } else if (step.deletePost) {
        const targetIds = postedByStep.get(step.deletePost.step)
        if (!targetIds || targetIds.length === 0) throw new Error(`шаг ${index}: нет поста шага ${step.deletePost.step} для удаления`)
        anchorId = targetIds[0]!
        await this.deps.poster.delete(step.slot ?? scenario.slot, targetIds)
        base.postedIds = targetIds
        this.log(`  · шаг ${index + 1}. ${step.title} → удаление #${anchorId}`)
      } else {
        this.log(`  · шаг ${index + 1}. ${step.title}`)
      }

      if (anchorId !== null) {
        if (expectedText !== null) {
          await this.waitForText(channelId, anchorId, expectedText)
        } else if (step.deletePost) {
          await this.waitForDeleted(channelId, anchorId)
        } else {
          const nudged = await this.awaitDelivery(channelId, anchorId)
          if (nudged) base.notes.push('пост доехал только после рестарта tg-ingest (постер делит сессию с воркером)')
          await waitForProcessed(this.deps.db, channelId, anchorId, {
            processTimeoutMs: this.options.processTimeoutMs ?? 120_000,
          })
        }
      }

      const evaluated = await this.evaluate(scenario, channelId, step, anchorId, ctx)
      base.problems = evaluated.problems
      if (evaluated.trace) base.trace = evaluated.trace
      if (evaluated.exchange) base.exchange = evaluated.exchange
      base.status = evaluated.problems.length === 0 ? 'passed' : 'failed'
      if (base.status === 'failed') {
        for (const problem of evaluated.problems) this.log(`      ✗ ${problem}`)
      }
    } catch (err) {
      base.status = 'error'
      base.error = err instanceof Error ? err.message : String(err)
      this.log(`      ⨯ ${base.error}`)
    }

    base.durationMs = Date.now() - startedAt
    return base
  }

  /**
   * Ожидания проверяются в цикле до settleMs: биржа и приватный WS догоняют состояние
   * асинхронно. Возвращаются проблемы ПОСЛЕДНЕЙ попытки — то есть та картина, которая
   * действительно осталась к дедлайну, а не случайная промежуточная.
   */
  private async evaluate(
    scenario: Scenario,
    channelId: number,
    step: Step,
    anchorId: number | null,
    ctx: StepContext,
  ): Promise<{ problems: string[]; trace?: MessageTrace; exchange?: StepResult['exchange'] }> {
    const expect = step.expect
    if (!expect) return { problems: [] }

    const deadline = Date.now() + (step.settleMs ?? this.options.settleMs ?? 25_000)
    let problems: string[] = []
    let lastTrace: MessageTrace | undefined
    let lastExchange: StepResult['exchange'] | undefined

    for (;;) {
      problems = []
      if (anchorId !== null) {
        const message = await findMessage(this.deps.db, channelId, anchorId)
        if (!message) {
          problems.push(`сообщения ${anchorId} нет в БД`)
        } else {
          lastTrace = await traceMessage(this.deps.db, channelId, message)
          problems.push(...checkMessage(expect, lastTrace))
          problems.push(...checkActions(expect.actions, lastTrace.actions))
          problems.push(...checkOrders(expect.orders, lastTrace.orders))
        }
      }

      if (expect.position) {
        const positions = lastTrace?.positions.length
          ? lastTrace.positions
          : await this.positionsFor(channelId, [expect.position.symbol])
        problems.push(...checkPosition(expect.position, positions))
      }

      if (expect.exchange) {
        const symbol = expect.exchange.symbol
        const [position, orders] = await Promise.all([positionOf(this.deps.rest, symbol), openOrdersOf(this.deps.rest, symbol)])
        lastExchange = { symbol, position, orders }
        problems.push(...checkExchange(expect.exchange, position, orders))
      }

      if (expect.custom && lastTrace) {
        problems.push(...(await expect.custom(lastTrace, ctx)))
      }

      if (problems.length === 0 || Date.now() >= deadline) break
      await sleep(1500)
    }

    return {
      problems,
      ...(lastTrace ? { trace: lastTrace } : {}),
      ...(lastExchange ? { exchange: lastExchange } : {}),
    }
  }

  private async positionsFor(channelId: number, symbols: string[]): Promise<MessageTrace['positions']> {
    return positionsOf(this.deps.db, channelId, symbols)
  }

  private buildContext(scenario: Scenario, postedByStep: Map<number, number[]>, currentIndex: number): StepContext {
    const priceOf = async (symbol: string, pct = 0): Promise<string> => {
      const [mark, instr] = await Promise.all([
        markPrice(this.deps.rest, symbol),
        instrument(this.deps.db, this.deps.config.network, symbol),
      ])
      const price = new Decimal(mark).mul(new Decimal(1).plus(new Decimal(pct).div(100)))
      // Шаг цены берём из локального кэша инструментов (его же использует движок); нет строки —
      // округляем до 4 знаков: это всё ещё валидная цена для любого ликвидного USDT-перпа.
      return instr ? roundToTick(price, instr.tickSize) : price.toDecimalPlaces(4).toString()
    }

    const channel = channelBySlot(this.deps.config, scenario.slot)

    return {
      mark: (symbol) => priceOf(symbol, 0),
      offset: (symbol, pct) => priceOf(symbol, pct),
      postedId: (stepIndex) => {
        const resolved = stepIndex < 0 ? currentIndex + stepIndex : stepIndex
        const ids = postedByStep.get(resolved)
        if (!ids || ids.length === 0) throw new Error(`e2e: шаг ${resolved} ещё не отправлял пост — нечего цитировать`)
        return ids[0]!
      },
      symbols: scenario.symbols,
      fixture: (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
      channelState: {
        positions: async (slot, symbols) => positionsOf(this.deps.db, channelBySlot(this.deps.config, slot).id, symbols),
        trades: async (slot, symbols) => tradesOf(this.deps.db, channelBySlot(this.deps.config, slot).id, symbols),
      },
      ops: {
        setCopyEnabled: async (enabled) => {
          await this.deps.db
            .updateTable('channel_settings')
            .set({ enabled, updated_at: new Date() })
            .where('channel_id', '=', channel.id)
            .execute()
        },
        closeOnExchange: async (symbol) => {
          await flatten(this.deps.rest, [symbol])
        },
      },
    }
  }

  /**
   * Ждёт появления строки сообщения в БД и, если постер делит сессию с воркером, лечит
   * «залипание» воркера рестартом (см. nudge.ts — там же вся причина). Возвращает true, если
   * рестарт понадобился: это не провал сценария, но факт для отчёта.
   */
  private async awaitDelivery(channelId: number, tgMessageId: number): Promise<boolean> {
    const softDeadline = Date.now() + (this.options.nudgeAfterMs ?? 15_000)
    for (;;) {
      if (await findMessage(this.deps.db, channelId, tgMessageId)) return false
      if (Date.now() >= softDeadline) break
      await sleep(1000)
    }
    if (!this.deps.poster.sharesWorkerSession) return false

    this.log('      … пост не доехал за отведённое время — перезапускаю tg-ingest')
    await nudgeIngest()
    const hardDeadline = Date.now() + 90_000
    for (;;) {
      if (await findMessage(this.deps.db, channelId, tgMessageId)) return true
      if (Date.now() >= hardDeadline) return true // дальше разберётся waitForProcessed со своей ошибкой
      await sleep(2000)
    }
  }

  /** Правка не переводит сообщение в 'received' — движок её НЕ переобрабатывает; ждём сам факт
   *  доставки правки в БД (text/edit_count обновились ingest'ом). */
  private async waitForText(channelId: number, tgMessageId: number, text: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const row = await findMessage(this.deps.db, channelId, tgMessageId)
      if (row && row.text === text) return
      if (Date.now() >= deadline) {
        throw new Error(`e2e: правка сообщения ${tgMessageId} не доехала до БД за ${timeoutMs} мс (в БД: '${row?.text ?? '—'}')`)
      }
      await sleep(1000)
    }
  }

  private async waitForDeleted(channelId: number, tgMessageId: number, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const row = await findMessage(this.deps.db, channelId, tgMessageId)
      if (row?.deleted === true) return
      if (Date.now() >= deadline) {
        throw new Error(`e2e: удаление сообщения ${tgMessageId} не отразилось в БД за ${timeoutMs} мс`)
      }
      await sleep(1000)
    }
  }

  private log(line: string): void {
    if (this.options.verbose !== false) console.log(line)
  }
}
