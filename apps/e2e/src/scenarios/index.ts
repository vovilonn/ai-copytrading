import type { Scenario } from '../scenario.js'
import { smokeCh1 } from './smoke.js'
import { ch1Busy, ch1Fraction, ch1Guards, ch1Lifecycle, ch1Media, ch1Noise, ch1ShortBreakeven } from './ch1.js'
import { ch2Freeform, ch2Limit, ch2MarketFlow, ch2Noise, ch2Structured, ch2Vision } from './ch2.js'
import { opsCopyDisabled, opsManualClose } from './ops.js'

/**
 * Каталог сценариев. Порядок = порядок прогона (`pnpm e2e run`): сначала дымовой (если он
 * красный — чинить надо инфраструктуру, а не бота), затем канал 1 (детерминированный разбор),
 * затем канал 2 (модель), затем операционные сценарии.
 *
 * Подробное описание каждого кейса и того, ЧТО именно он ловит — docs/e2e/test-plan.md.
 */
export const SCENARIOS: readonly Scenario[] = [
  smokeCh1,
  ch1ShortBreakeven,
  ch1Fraction,
  ch1Busy,
  ch1Guards,
  ch1Noise,
  ch1Media,
  ch1Lifecycle,
  ch2Structured,
  ch2MarketFlow,
  ch2Limit,
  ch2Freeform,
  ch2Noise,
  ch2Vision,
  opsCopyDisabled,
  opsManualClose,
]
