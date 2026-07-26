import { parseArgs } from 'node:util'
import { loadE2eConfig, channelBySlot, type ChannelSlot } from './env.js'
import { applyTestProfile, connect, findMessage, trace as traceMessage, channelState } from './db.js'
import { createRest, flatten, snapshot } from './exchange.js'
import { TgPoster } from './tg.js'
import { doctor } from './doctor.js'
import { reset, DEFAULT_TEST_PROFILE } from './reset.js'
import { ScenarioRunner } from './runner.js'
import { printChecks, printSummary, writeRunArtifacts } from './report.js'
import { createPosterSession } from './session.js'
import { SCENARIOS } from './scenarios/index.js'
import type { Scenario } from './scenario.js'

/**
 * CLI e2e-петли: `pnpm e2e <команда>`.
 *
 *   doctor            — готов ли стек к прогону (и что именно мешает)
 *   reset             — чистый лист: биржа в ноль, следы тестовых каналов из БД, курсор на «сейчас»
 *   list              — список сценариев
 *   run               — прогон сценариев с отчётом
 *   post              — ручной пост в тестовый канал (отладка «на живую»)
 *   trace             — что бот сделал с последними сообщениями канала
 *   flatten           — аварийно закрыть всё на бирже
 */

const USAGE = `
Использование: pnpm e2e <команда> [опции]

  session [--print]               завести постеру ОТДЕЛЬНУЮ сессию Telegram (E2E_TG_SESSION)
  doctor                          проверка готовности стека
  reset [--no-flatten]            чистый лист (биржа + БД + курсор)
        [--trade-size 150] [--max-notional 300] [--max-leverage 10]
  list [--tag <тег>]              список сценариев
  run [--only id1,id2] [--tag t]  прогон сценариев
      [--repeat N]                прогнать выбранное N раз подряд (ловля «плавающих» дефектов)
      [--no-reset]                не сбрасывать состояние перед каждым сценарием
      [--keep-open]               не закрывать позиции после прогона
      [--settle-ms 25000] [--timeout-ms 120000]
  post --ch <1|2> --text "..."    ручной пост
       [--photo путь] [--album a.jpg,b.jpg] [--reply <tg_id>]
  trace --ch <1|2> [--last 5]     разбор последних сообщений канала
  flatten [--symbol BTCUSDT]      закрыть позиции/снять ордера на бирже
`

async function main(): Promise<number> {
  const command = process.argv[2]
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE)
    return 0
  }

  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      ch: { type: 'string' },
      text: { type: 'string' },
      photo: { type: 'string' },
      album: { type: 'string' },
      reply: { type: 'string' },
      only: { type: 'string' },
      tag: { type: 'string' },
      last: { type: 'string' },
      print: { type: 'boolean' },
      symbol: { type: 'string' },
      'trade-size': { type: 'string' },
      'max-notional': { type: 'string' },
      'max-leverage': { type: 'string' },
      'settle-ms': { type: 'string' },
      repeat: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'no-flatten': { type: 'boolean' },
      'no-reset': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
    },
    allowPositionals: true,
  })

  const config = loadE2eConfig()

  // session/list не требуют ни БД, ни постера — отвечаем до любых лишних подключений.
  if (command === 'session') {
    const result = await createPosterSession(config, { write: values.print !== true })
    console.log(`\n  создана отдельная сессия для постера, аккаунт: ${result.user}`)
    if (result.writtenTo) console.log(`  E2E_TG_SESSION записан в ${result.writtenTo}`)
    else console.log(`\nE2E_TG_SESSION=${result.session}\n`)
    console.log('')
    return 0
  }

  if (command === 'list') {
    const scenarios = filterScenarios(SCENARIOS, values.only, values.tag)
    console.log(`\n  Сценариев: ${scenarios.length}\n`)
    for (const s of scenarios) {
      console.log(`  ${s.id.padEnd(30)} канал ${s.slot}  [${(s.tags ?? []).join(', ')}]  ${s.title}`)
    }
    console.log('')
    return 0
  }

  const db = connect(config.databaseUrl)
  const rest = createRest(config)
  let poster: TgPoster | null = null
  const needsTelegram = ['doctor', 'reset', 'run', 'post'].includes(command)
  // Клиент только создаётся: соединение открывается на время каждой операции и сразу закрывается
  // (иначе tg-ingest с той же сессией не получает realtime — подробности в tg.ts).
  if (needsTelegram) poster = TgPoster.create(config)

  try {
    switch (command) {
      case 'doctor': {
        const checks = await doctor({ config, db, rest, poster: poster! })
        printChecks(checks)
        return checks.some((c) => c.level === 'fail') ? 1 : 0
      }

      case 'reset': {
        const report = await reset(
          { config, db, rest, poster: poster! },
          {
            profile: {
              ...DEFAULT_TEST_PROFILE,
              tradeSize: values['trade-size'] ?? DEFAULT_TEST_PROFILE.tradeSize,
              maxSymbolNotional: values['max-notional'] ?? DEFAULT_TEST_PROFILE.maxSymbolNotional,
              maxLeverage: values['max-leverage'] ?? DEFAULT_TEST_PROFILE.maxLeverage,
            },
            flattenExchange: values['no-flatten'] !== true,
          },
        )
        console.log('')
        if (report.flattened) {
          console.log(
            `  биржа: закрыто позиций ${report.flattened.closed.length}${report.flattened.closed.length ? ` (${report.flattened.closed.join(', ')})` : ''}` +
              (report.flattened.leftovers.length ? `, ОСТАЛОСЬ: ${report.flattened.leftovers.join(', ')}` : ''),
          )
        }
        for (const channel of report.channels) {
          console.log(
            `  канал ${channel.slot} «${channel.title}»: удалено сообщений ${channel.purged.messages}, действий ${channel.purged.actions}, ` +
              `сделок ${channel.purged.trades}, ордеров ${channel.purged.orders}, позиций ${channel.purged.positions}; ` +
              `курсор ${channel.cursorFrom} → ${channel.cursorTo}`,
          )
        }
        console.log('')
        return 0
      }

      case 'flatten': {
        const result = await flatten(rest, values.symbol ? [values.symbol] : undefined)
        console.log(`\n  закрыто: ${result.closed.map((c) => `${c.symbol} ${c.side} ${c.size}`).join(', ') || '—'}`)
        console.log(`  снято ордеров по символам: ${result.cancelledSymbols.join(', ') || '—'}`)
        if (result.leftovers.length) console.log(`  ОСТАЛОСЬ: ${result.leftovers.join(', ')}`)
        const state = await snapshot(rest)
        console.log(`  итог: позиций ${state.positions.length}, ордеров ${state.orders.length}\n`)
        return result.leftovers.length === 0 ? 0 : 1
      }

      case 'post': {
        const slot = parseSlot(values.ch)
        const channel = channelBySlot(config, slot)
        const result = await poster!.post(slot, {
          ...(values.text !== undefined ? { text: values.text } : {}),
          ...(values.photo !== undefined ? { photo: values.photo } : {}),
          ...(values.album !== undefined ? { album: values.album.split(',') } : {}),
          ...(values.reply !== undefined ? { replyTo: Number(values.reply) } : {}),
        })
        console.log(`\n  отправлено в «${channel.key}»: ${result.ids.join(', ')} (якорь ${result.anchorId})\n`)
        return 0
      }

      case 'trace': {
        const slot = parseSlot(values.ch)
        const channel = channelBySlot(config, slot)
        const limit = Number(values.last ?? '5')
        const state = await channelState(db, channel.id)
        console.log(`\n  канал ${slot} «${state?.title ?? channel.key}» (id=${channel.id}), курсор=${state?.lastSeenMessageId}\n`)
        const recent = await db
          .selectFrom('messages')
          .select('tg_message_id')
          .where('channel_id', '=', channel.id)
          .orderBy('tg_message_id', 'desc')
          .limit(limit)
          .execute()
        for (const row of recent.reverse()) {
          const message = await findMessage(db, channel.id, Number(row.tg_message_id))
          if (!message) continue
          const t = await traceMessage(db, channel.id, message)
          console.log(`  #${message.tgMessageId} [${message.status}${message.statusReason ? `/${message.statusReason}` : ''}] ${message.text.replace(/\n/g, ' | ').slice(0, 90)}`)
          for (const p of t.parseResults) console.log(`      разбор ${p.parser} → ${p.route}${p.reason ? ` (${p.reason})` : ''} conf=${p.confidence}`)
          for (const a of t.actions) console.log(`      действие ${a.actionIndex}: ${a.type}/${a.status} ${a.symbol ?? ''} ${a.skipReason ?? ''}`)
          for (const o of t.orders) console.log(`      ордер ${o.purpose} ${o.side} qty=${o.qty} @${o.price ?? 'mkt'} → ${o.status}`)
          for (const c of t.aiCalls) console.log(`      AI ${c.model} ${c.latencyMs}мс${c.error ? ` ошибка: ${c.error}` : ''}`)
        }
        console.log('')
        return 0
      }

      case 'run': {
        const scenarios = filterScenarios(SCENARIOS, values.only, values.tag)
        if (scenarios.length === 0) {
          console.error('  подходящих сценариев нет — проверьте --only/--tag (`pnpm e2e list`)')
          return 1
        }
        const runner = new ScenarioRunner(
          { config, db, rest, poster: poster! },
          {
            ...(values['settle-ms'] ? { settleMs: Number(values['settle-ms']) } : {}),
            ...(values['timeout-ms'] ? { processTimeoutMs: Number(values['timeout-ms']) } : {}),
          },
        )

        const startedAt = new Date()
        const results = []
        // --repeat: некоторые дефекты «плавают» (гонки зеркала позиций, редкие таймауты биржи).
        // Один зелёный прогон их не опровергает — повтор даёт статистику, а не единичный факт.
        const repeat = Math.max(1, Number(values.repeat ?? '1'))
        for (let pass = 1; pass <= repeat; pass++) {
          if (repeat > 1) console.log(`\n═══ проход ${pass} из ${repeat} ═══`)
          for (const scenario of scenarios) {
            if (values['no-reset'] !== true) {
              await reset({ config, db, rest, poster: poster! }, { profile: DEFAULT_TEST_PROFILE })
            }
            const result = await runner.run(scenario)
            results.push(repeat > 1 ? { ...result, id: `${result.id}#${pass}` } : result)
          }
        }

        if (values['keep-open'] !== true) {
          const cleanup = await flatten(rest)
          if (cleanup.leftovers.length > 0) {
            console.log(`\n  ВНИМАНИЕ: после прогона на бирже осталось: ${cleanup.leftovers.join(', ')}`)
          }
        }
        printSummary(results)
        const artifacts = await writeRunArtifacts(results, startedAt)
        console.log(`  отчёт: ${artifacts.markdownPath}\n`)
        return results.every((r) => r.status === 'passed' || r.status === 'skipped') ? 0 : 1
      }

      default:
        console.error(`неизвестная команда: ${command}`)
        console.log(USAGE)
        return 1
    }
  } finally {
    // Страховка на ЛЮБОЙ исход, включая Ctrl+C и падение: сценарий ops-copy-disabled выключает
    // копирование первым шагом и включает последним, а при срыве шага раннер помечает остальные
    // пропущенными — «включаем обратно» тогда не выполняется. Оставленный выключенным канал
    // теперь ещё коварнее: сообщения не разбираются вовсе, и следующий прогон даёт пустые трейсы
    // без единой подсказки. Поэтому профиль восстанавливается здесь, а не в теле команды.
    if (command === 'run') {
      for (const channel of config.channels) {
        await applyTestProfile(db, channel.id, DEFAULT_TEST_PROFILE).catch((err) =>
          console.error(`  не удалось вернуть профиль канала ${channel.id}: ${String(err)}`),
        )
      }
    }
    await poster?.close()
    await db.destroy()
  }
}

function parseSlot(raw: string | undefined): ChannelSlot {
  const slot = Number(raw)
  if (slot !== 1 && slot !== 2) throw new Error('e2e: укажите канал --ch 1 (структурный) или --ch 2 (свободный текст)')
  return slot
}

function filterScenarios(all: readonly Scenario[], only?: string, tag?: string): Scenario[] {
  let list = [...all]
  if (only) {
    const ids = only.split(',').map((s) => s.trim())
    list = list.filter((s) => ids.includes(s.id))
  }
  if (tag) list = list.filter((s) => (s.tags ?? []).includes(tag))
  return list
}

main()
  .then((code) => {
    process.exit(code)
  })
  .catch((err) => {
    console.error(`\n  ⨯ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
