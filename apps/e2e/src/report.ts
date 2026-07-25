import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Check } from './doctor.js'
import type { ScenarioResult, StepResult } from './runner.js'

/**
 * Вывод результатов. Консоль — для человека прямо сейчас; JSON + Markdown в var/e2e/runs/ —
 * чтобы прогон можно было приложить к отчёту и сравнить с предыдущим (что именно сломалось
 * между двумя запусками, видно диффом двух markdown-файлов).
 */

const ICONS: Record<string, string> = { ok: '✔', warn: '▲', fail: '✖', passed: '✔', failed: '✖', error: '⨯', skipped: '–' }

export function printChecks(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.name.length))
  console.log('')
  for (const check of checks) {
    console.log(`  ${ICONS[check.level]} ${check.name.padEnd(width)}  ${check.detail}`)
  }
  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  console.log(`\n  Итог: ${checks.length - fails - warns} ок, ${warns} предупреждений, ${fails} блокеров\n`)
}

export function printSummary(results: ScenarioResult[]): void {
  console.log('\n' + '─'.repeat(78))
  console.log('  ИТОГ ПРОГОНА')
  console.log('─'.repeat(78))
  for (const scenario of results) {
    const steps = scenario.steps
    const passed = steps.filter((s) => s.status === 'passed').length
    console.log(
      `  ${ICONS[scenario.status]} ${scenario.id.padEnd(28)} ${String(passed).padStart(2)}/${steps.length} шагов  ${(scenario.durationMs / 1000).toFixed(0)}с  ${scenario.title}`,
    )
    for (const step of steps) {
      for (const note of step.notes) console.log(`      ℹ шаг ${step.index + 1}: ${note}`)
      if (step.status === 'passed') continue
      console.log(`      ${ICONS[step.status]} шаг ${step.index + 1}: ${step.title}`)
      for (const problem of step.problems) console.log(`         · ${problem}`)
      if (step.error) console.log(`         · ${step.error}`)
    }
  }
  const passed = results.filter((r) => r.status === 'passed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  console.log('─'.repeat(78))
  console.log(
    `  Сценариев: ${results.length}, пройдено: ${passed}, провалено: ${results.length - passed - skipped}` +
      (skipped > 0 ? `, пропущено: ${skipped}` : ''),
  )
  console.log('─'.repeat(78) + '\n')
}

function repoRoot(): string {
  // apps/e2e/src/report.ts -> ../../../ = корень репозитория (тот же приём, что в env.ts).
  return fileURLToPath(new URL('../../../', import.meta.url))
}

export interface RunArtifacts {
  jsonPath: string
  markdownPath: string
}

export async function writeRunArtifacts(results: ScenarioResult[], startedAt: Date): Promise<RunArtifacts> {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(repoRoot(), 'var', 'e2e', 'runs')
  await fs.mkdir(dir, { recursive: true })

  const jsonPath = path.join(dir, `${stamp}.json`)
  await fs.writeFile(jsonPath, JSON.stringify({ startedAt: startedAt.toISOString(), results }, null, 2), 'utf8')

  const markdownPath = path.join(dir, `${stamp}.md`)
  await fs.writeFile(markdownPath, renderMarkdown(results, startedAt), 'utf8')

  return { jsonPath, markdownPath }
}

function renderMarkdown(results: ScenarioResult[], startedAt: Date): string {
  const lines: string[] = []
  const passed = results.filter((r) => r.status === 'passed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  lines.push(`# E2E-прогон ${startedAt.toISOString()}`)
  lines.push('')
  lines.push(
    `Сценариев: **${results.length}**, пройдено: **${passed}**, провалено: **${results.length - passed - skipped}**` +
      (skipped > 0 ? `, пропущено: **${skipped}**` : ''),
  )
  lines.push('')
  lines.push('| Сценарий | Канал | Шаги | Время | Итог |')
  lines.push('|---|---|---|---|---|')
  for (const r of results) {
    const ok = r.steps.filter((s) => s.status === 'passed').length
    lines.push(`| \`${r.id}\` — ${r.title} | ${r.slot} | ${ok}/${r.steps.length} | ${(r.durationMs / 1000).toFixed(0)}с | ${ICONS[r.status]} ${r.status} |`)
  }
  lines.push('')

  for (const scenario of results) {
    lines.push(`## ${ICONS[scenario.status]} ${scenario.id} — ${scenario.title}`)
    if (scenario.note) lines.push(`\n_${scenario.note}_`)
    lines.push('')
    for (const step of scenario.steps) {
      lines.push(`### ${ICONS[step.status]} Шаг ${step.index + 1}. ${step.title}`)
      if (step.postedText) {
        lines.push('')
        lines.push('```')
        lines.push(step.postedText)
        lines.push('```')
      }
      lines.push('')
      lines.push(...renderStepFacts(step))
      if (step.notes.length > 0) {
        lines.push('')
        for (const note of step.notes) lines.push(`> ℹ ${note}`)
      }
      if (step.problems.length > 0) {
        lines.push('')
        lines.push('**Расхождения:**')
        for (const problem of step.problems) lines.push(`- ${problem}`)
      }
      if (step.error) {
        lines.push('')
        lines.push(`**Ошибка:** ${step.error}`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

function renderStepFacts(step: StepResult): string[] {
  const lines: string[] = []
  const trace = step.trace
  if (trace) {
    lines.push(
      `- сообщение: \`${trace.message.status}\`${trace.message.statusReason ? ` (${trace.message.statusReason})` : ''}, method=${trace.message.method ?? '—'}`,
    )
    if (trace.parseResults.length > 0) {
      lines.push(
        `- разбор: ${trace.parseResults.map((p) => `${p.parser}→${p.route}${p.reason ? `(${p.reason})` : ''} conf=${p.confidence}`).join('; ')}`,
      )
    }
    if (trace.actions.length > 0) {
      lines.push(
        `- действия: ${trace.actions.map((a) => `${a.type}/${a.status}${a.symbol ? ` ${a.symbol}` : ''}${a.skipReason ? ` (${a.skipReason})` : ''}`).join('; ')}`,
      )
    }
    if (trace.orders.length > 0) {
      lines.push(
        `- ордера: ${trace.orders.map((o) => `${o.purpose} ${o.side} qty=${o.qty ?? '—'} @${o.price ?? 'mkt'} → ${o.status}${o.retCode ? ` retCode=${o.retCode}` : ''}`).join('; ')}`,
      )
    }
    if (trace.positions.length > 0) {
      lines.push(
        `- позиции (БД): ${trace.positions.map((p) => `${p.symbol} ${p.side ?? '—'} size=${p.size} sl=${p.stopLoss ?? '—'}`).join('; ')}`,
      )
    }
    if (trace.aiCalls.length > 0) {
      lines.push(
        `- AI: ${trace.aiCalls.map((c) => `${c.model} ${c.latencyMs}мс${c.cacheHit ? ' (кэш)' : ''}${c.escalated ? ' эскалация' : ''}${c.error ? ` ошибка: ${c.error}` : ''}`).join('; ')}`,
      )
    }
    if (trace.message.aiSummary) lines.push(`- саммари модели: ${trace.message.aiSummary}`)
  }
  if (step.exchange) {
    const p = step.exchange.position
    lines.push(
      `- биржа ${step.exchange.symbol}: ${p ? `${p.side} size=${p.size} avg=${p.avgPrice} sl=${p.stopLoss || '—'}` : 'позиции нет'}, живых ордеров ${step.exchange.orders.length}`,
    )
  }
  return lines
}
