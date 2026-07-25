import { Decimal } from 'decimal.js'
import type { Scenario } from '../scenario.js'

/**
 * Канал 2 — СВОБОДНЫЙ текст (адаптер ch2-freeform): правила A (структурный сигнал) → B (лимитка)
 * → C (вход с текущих) → D (стоп с тикером) → E/F (всё остальное уходит в AI) → шумовой фолбэк.
 *
 * Разница с каналом 1 принципиальна: здесь у половины сообщений разбор делает МОДЕЛЬ. Поэтому
 * сценарии проверяют не только «что исполнилось», но и КАКИМ путём (messages.method: 'auto' —
 * детерминированный разбор, 'ai' — модель), и что дорогая ветка не вызывается там, где хватает
 * шаблона.
 */

export const ch2Structured: Scenario = {
  id: 'ch2-structured',
  title: 'Структурный сигнал канала 2 (правило A, без AI)',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'entry'],
  note: 'Формат «#SOLUSDT LONG / Entry price / Targets / Stop loss» разбирается шаблоном с confidence 1.0 — модель звать не должны, method обязан быть auto.',
  steps: [
    {
      title: 'Вход по структурному сигналу',
      post: async (ctx) => ({
        text: [
          '#SOLUSDT LONG',
          `Entry price: ${await ctx.offset('SOLUSDT', -0.1)} - ${await ctx.offset('SOLUSDT', 0.1)}`,
          // Цели разделяются keycap-эмодзи (1️⃣2️⃣) — ровно как в боевом канале: без них
          // splitKeycaps видит одну строку, а пробел между числами трактуется как разделитель
          // разрядов, и «76.22 78.44» превращается в одно число 76.2278.
          `Targets: 1️⃣${await ctx.offset('SOLUSDT', 3)} 2️⃣${await ctx.offset('SOLUSDT', 6)}`,
          `Stop loss: ${await ctx.offset('SOLUSDT', -5)}`,
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        method: 'auto',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'long' }],
        orders: [
          { purpose: 'entry', count: 1 },
          { purpose: 'sl', count: 1 },
          { purpose: 'tp', count: 2 },
        ],
        exchange: { symbol: 'SOLUSDT', position: 'long', stopLoss: true, openOrdersMin: 2 },
        custom: (trace) => (trace.aiCalls.length === 0 ? [] : [`шаблон справился сам, но модель всё равно вызвана ${trace.aiCalls.length} раз(а) — лишние деньги`]),
      },
    },
    {
      title: 'Закрытие остатка',
      post: { text: 'Закрываю SOL полностью, забираем профит' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}

export const ch2MarketFlow: Scenario = {
  id: 'ch2-market-flow',
  title: 'Вход с текущих → стоп от автора → фиксация половины (AI) → закрытие',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'entry', 'delta', 'ai'],
  note: 'Полный жизненный цикл свободного канала: C (вход без стопа — движок вешает СВОЙ защитный стоп), D (стоп автора заменяет защитный), E/F (фиксация половины разбирается моделью).',
  steps: [
    {
      title: 'Вход «с текущих» без стопа',
      post: { text: 'Захожу с текущих в SOL long, работаем' },
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'long' }],
        // Автор стоп не назвал — политика канала attach_protective_sl обязана повесить свой.
        position: { symbol: 'SOLUSDT', side: 'long', stopLossSet: true },
        exchange: { symbol: 'SOLUSDT', position: 'long', stopLoss: true },
      },
    },
    {
      title: 'Автор присылает свой стоп',
      post: async (ctx) => ({ text: `SOL стоп ${await ctx.offset('SOLUSDT', -3)}` }),
      expect: {
        status: 'executed',
        actions: [{ type: 'modify_sl', status: 'executed', symbol: 'SOLUSDT' }],
        custom: async (trace, ctx) => {
          const position = trace.positions.find((p) => p.symbol === 'SOLUSDT')
          if (!position?.stopLoss) return ['в зеркале позиции нет стопа']
          const expected = new Decimal(await ctx.offset('SOLUSDT', -3))
          const diffPct = new Decimal(position.stopLoss).minus(expected).abs().div(expected).mul(100)
          return diffPct.lte('1') ? [] : [`стоп ${position.stopLoss} далёк от присланного ${expected.toString()}`]
        },
      },
    },
    {
      title: 'Фиксация половины (разбирает модель)',
      post: { text: 'Фиксирую половину объёма по SOL, остальное тянем' },
      expect: {
        status: 'executed',
        method: 'ai',
        actions: [{ type: 'partial_close', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'long' },
        custom: (trace) => (trace.aiCalls.length > 0 ? [] : ['ветка AI не вызывалась, хотя разбор помечен как ai']),
      },
    },
    {
      title: 'Закрытие остатка',
      post: { text: 'Закрываю остаток по SOL' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}

export const ch2Limit: Scenario = {
  id: 'ch2-limit',
  title: 'Отложенный вход лимиткой (правило B)',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'entry'],
  note: 'Лимитка по определению стоит вне рынка — гейт slippage к ней применяться не должен. Ожидаем живой лимитный ордер на бирже и НЕОТКРЫТУЮ позицию (сделка в статусе pending).',
  steps: [
    {
      title: 'Лимитка на 3% ниже рынка',
      post: async (ctx) => ({ text: `Limit long sol ${await ctx.offset('SOLUSDT', -3)}` }),
      expect: {
        status: 'executed',
        method: 'auto',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'long' }],
        orders: [{ purpose: 'entry', count: 1, status: 'submitted' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMin: 1 },
        custom: (trace) => {
          const entry = trace.orders.find((o) => o.purpose === 'entry')
          if (!entry) return ['нет входного ордера']
          return entry.orderType === 'limit' ? [] : [`ожидали лимитный ордер, получили '${entry.orderType}'`]
        },
      },
    },
  ],
}

export const ch2Freeform: Scenario = {
  id: 'ch2-freeform',
  title: 'Чистый свободный текст — разбирает модель',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'ai'],
  note: 'Ни одно правило шаблона не срабатывает: формулировка без слов «стоп», «limit» и «с текущих» (иначе сработали бы правила B/C/D). Это ровно тот случай, ради которого AI-слой и существует.',
  steps: [
    {
      title: 'Свободная формулировка входа со стопом и целями',
      post: async (ctx) => ({
        text: `Захожу в солану от текущей цены, защиту ставлю под ${await ctx.offset('SOLUSDT', -4)}, забираю по ${await ctx.offset('SOLUSDT', 3)} и ${await ctx.offset('SOLUSDT', 6)}`,
      }),
      expect: {
        status: 'executed',
        method: 'ai',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'long' }],
        exchange: { symbol: 'SOLUSDT', position: 'long', stopLoss: true },
      },
    },
    {
      title: 'Закрытие',
      post: { text: 'Закрываю SOL полностью' },
      expect: { status: 'executed', exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 } },
    },
  ],
}

export const ch2Noise: Scenario = {
  id: 'ch2-noise',
  title: 'Шумовые гейты свободного канала',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'noise'],
  note: 'Форум — это чат: половина сообщений болтовня. Проверяем бесплатные гейты ДО модели (совет «можно…», отсутствие монеты/торгового маркера, обзор) — они экономят деньги и не дают исполнить предположение как приказ.',
  steps: [
    {
      title: 'Совет в условной форме («можно со стопом …»)',
      post: async (ctx) => ({ text: `Можно со стопом ${await ctx.offset('SOLUSDT', -6)} посидеть, если кто в позиции` }),
      expect: {
        status: 'noise',
        custom: (trace) => (trace.aiCalls.length === 0 ? [] : ['на совет вызвана модель — лишние деньги']),
      },
    },
    {
      title: 'Болтовня без монеты и торговых маркеров',
      post: { text: 'Всем привет, как настроение сегодня' },
      expect: { status: 'noise', custom: (trace) => (trace.aiCalls.length === 0 ? [] : ['на болтовню вызвана модель']) },
    },
    {
      title: 'Обзор недели',
      post: { text: 'Вечером выложу обзор по рынку и итоги недели' },
      expect: { status: 'noise' },
    },
  ],
}

export const ch2Vision: Scenario = {
  id: 'ch2-vision',
  title: 'Картинка с графиком уходит в модель со зрением',
  slot: 2,
  symbols: ['SOLUSDT'],
  tags: ['ch2', 'media', 'ai'],
  note: 'Скрин графика — это половина сигналов свободного канала. Проверяем, что needs_vision выставлен и модель реально получила картинку (ai_calls не пуст).',
  steps: [
    {
      title: 'График с короткой подписью',
      post: (ctx) => ({ text: 'Разметка по SOL, забираю от уровня', photo: ctx.fixture('chart-2.jpg') }),
      expect: {
        custom: (trace) => {
          const problems: string[] = []
          if (!trace.message.hasMedia) problems.push('сообщение сохранено без пометки медиа')
          const det = trace.parseResults.find((p) => p.parser === 'deterministic')
          if (det?.route === 'ai' && !det.needsVision) problems.push('needs_vision=false — модель не увидит график')
          // Проверяем РАЗБОР моделью, а не факт сетевого вызова: повторный прогон того же
          // сообщения берёт ответ из ai_cache (ai_calls тогда пуст) — это штатная экономия,
          // а не «модель не отработала».
          const aiParse = trace.parseResults.find((p) => p.parser === 'ai')
          if (det?.route === 'ai' && !aiParse) problems.push('route=ai, но разбора моделью в parse_results нет')
          return problems
        },
      },
    },
  ],
}
