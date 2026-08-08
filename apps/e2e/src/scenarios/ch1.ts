import { Decimal } from 'decimal.js'
import type { Scenario, StepContext } from '../scenario.js'

/**
 * Канал 1 — СТРУКТУРНЫЕ сигналы, разбирает regex-адаптер ch1-structured
 * (правила R1 entry_signal → R2 multi_mgmt → R5 noise → R3 delta-reply → R4 delta-standalone
 * → фолбэк в AI). Сценарии ниже покрывают каждое правило и каждую защитную ветку входа.
 *
 * Все цены строятся от ЖИВОГО mark price (ctx.offset): вход всегда рыночный, а гейт slippage
 * рубит сигнал, чья цена ушла от рынка больше чем на MAX_ENTRY_SLIPPAGE_PCT (0.5%).
 */

/** Каноничный структурный сигнал канала 1 (тот же формат, что и в боевом канале). */
async function entrySignal(
  ctx: StepContext,
  params: { symbol: string; ticker: string; side: 'LONG' | 'SHORT'; offsetPct?: number; risk?: string },
): Promise<string> {
  const dir = params.side === 'LONG' ? 1 : -1
  const shift = params.offsetPct ?? 0
  const lines = [
    `#${params.ticker}/USDT ${params.side === 'LONG' ? '📈 LONG' : '📉 SHORT'}`,
    '',
    `Диапазон входа: ${await ctx.offset(params.symbol, shift - 0.1)}-${await ctx.offset(params.symbol, shift + 0.1)}$`,
    '',
    // TP/SL считаются ОТНОСИТЕЛЬНО сдвинутого входа, а не рынка: иначе у «устаревшего» сигнала
    // (offsetPct=-5) стоп совпал бы со входом и раньше слиппеджа сработал бы гейт invalid_sl_side —
    // поймано прогоном, сценарий проверял не ту ветку.
    `TP: ${await ctx.offset(params.symbol, shift + dir * 3)}$ - ${await ctx.offset(params.symbol, shift + dir * 6)}$`,
    '',
    `SL: ${await ctx.offset(params.symbol, shift + dir * -5)}$`,
  ]
  if (params.risk) lines.push('', `Риск: ${params.risk}%`)
  return lines.join('\n')
}

export const ch1ShortBreakeven: Scenario = {
  id: 'ch1-short-be',
  title: 'SHORT-вход → стоп в безубыток → закрытие через «Менеджмент»',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'entry', 'delta'],
  note: 'R1 (short) + R3 (delta-reply sl_breakeven) + R2 (multi_mgmt). Проверяет, что сторона сигнала доходит до биржи, безубыток берётся из средней входа, а «Менеджмент» закрывает позицию.',
  steps: [
    {
      title: 'Вход SHORT по структурному сигналу',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'SHORT' }) }),
      expect: {
        status: 'executed',
        method: 'auto',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'short', skipReason: null }],
        position: { symbol: 'SOLUSDT', side: 'short', stopLossSet: true },
        exchange: { symbol: 'SOLUSDT', position: 'short', stopLoss: true },
      },
    },
    {
      title: 'Стоп в безубыток ответом на сигнал',
      post: (ctx) => ({ text: '#SOL стоп перевел в б/у, дальше по плану', replyTo: ctx.postedId(0) }),
      expect: {
        // Оба исхода корректны и зависят от рынка: если цена ушла против позиции, безубыток
        // оказывается по ту сторону рынка, биржа такой стоп отвергла бы — движок штатно
        // пропускает операцию (sl_beyond_market), а не роняет сообщение.
        status: 'executed',
        actions: [{ type: 'modify_sl', status: ['executed', 'skipped'], symbol: 'SOLUSDT' }],
        custom: (trace) => {
          const action = trace.actions[0]
          if (!action) return ['нет действия modify_sl']
          if (action.status === 'skipped') {
            return action.skipReason === 'sl_beyond_market'
              ? []
              : [`пропуск переноса стопа по неожиданной причине: ${action.skipReason}`]
          }
          const position = trace.positions.find((p) => p.symbol === 'SOLUSDT')
          if (!position?.stopLoss || !position.avgPrice) return ['стоп исполнен, но зеркало позиции без цены стопа/входа']
          const diffPct = new Decimal(position.stopLoss).minus(position.avgPrice).abs().div(position.avgPrice).mul(100)
          return diffPct.lte('0.5') ? [] : [`стоп ${position.stopLoss} не равен средней входа ${position.avgPrice} (расхождение ${diffPct.toFixed(2)}%)`]
        },
      },
    },
    {
      title: 'Закрытие через «Менеджмент»',
      post: { text: 'Менеджмент по открытым позициям:\n\n#SOL - закрываю остаток по текущим' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        position: { symbol: 'SOLUSDT', side: 'flat' },
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}

export const ch1Guards: Scenario = {
  id: 'ch1-guards',
  title: 'Защитные ветки входа: устаревшая цена, стоп не с той стороны, неизвестный тикер',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'guards'],
  note: 'Ни один шаг НЕ должен открыть позицию. Проверяются гейты pipeline.ts: targets_passed, invalid_sl_side и маршрут в AI для нерезолвящегося символа.',
  steps: [
    {
      // Гейт слиппеджа выключен (решение заказчика 08.08.2026 — он рубил живые сделки на
      // полупроцентном отклонении), протухший сигнал теперь ловится по ЦЕЛЯМ: вход −10% от
      // рынка означает, что обе цели (+3% и +6% от входа) остались НИЖЕ рынка, то есть движение
      // уже отработано и закрываться лонгу негде.
      title: 'Сигнал, движение которого рынок уже отработал (все цели пройдены)',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'LONG', offsetPct: -10 }) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'skipped', symbol: 'SOLUSDT', skipReason: 'targets_passed' }],
        position: { symbol: 'SOLUSDT', side: 'flat' },
        exchange: { symbol: 'SOLUSDT', position: 'flat' },
      },
    },
    {
      title: 'LONG со стопом ВЫШЕ входа (стоп не с той стороны)',
      post: async (ctx) => ({
        text: [
          '#SOL/USDT 📈 LONG',
          '',
          `Диапазон входа: ${await ctx.offset('SOLUSDT', -0.1)}-${await ctx.offset('SOLUSDT', 0.1)}$`,
          '',
          `TP: ${await ctx.offset('SOLUSDT', 3)}$`,
          '',
          `SL: ${await ctx.offset('SOLUSDT', 5)}$`,
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'skipped', symbol: 'SOLUSDT', skipReason: 'invalid_sl_side' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat' },
      },
    },
    {
      title: 'Сигнал по несуществующему тикеру',
      post: async (ctx) => ({
        text: [
          '#ZZZQQ/USDT 📈 LONG',
          '',
          'Диапазон входа: 10.00-10.20$',
          '',
          'TP: 12.00$',
          '',
          'SL: 9.00$',
        ].join('\n'),
      }),
      expect: {
        // Символ не резолвится → regex уходит в AI (reason symbol_unknown), а вход, увиденный
        // только моделью по несуществующему инструменту, исполняться не должен ни при каких
        // обстоятельствах: ожидаем терминал без ордеров.
        status: ['needs_review', 'skipped', 'noise'],
        custom: (trace) => (trace.orders.length === 0 ? [] : [`по несуществующему тикеру ушло ${trace.orders.length} ордеров`]),
      },
    },
  ],
}

export const ch1Busy: Scenario = {
  id: 'ch1-busy',
  title: 'Повторный сигнал по занятому символу',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'guards'],
  note: 'Символ занят внутри канала (symbol_ownership) — второй вход обязан уйти в skipped(symbol_busy), не удваивая позицию.',
  steps: [
    {
      title: 'Первый вход',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'LONG' }) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: 'Тот же сигнал повторно',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'LONG' }) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'skipped', symbol: 'SOLUSDT', skipReason: 'symbol_busy' }],
      },
    },
    {
      title: 'Закрытие позиции',
      post: { text: '#SOL закрываю позицию полностью' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat' },
      },
    },
  ],
}

export const ch1Fraction: Scenario = {
  id: 'ch1-fraction',
  title: 'Доля фиксации: «25% фиксирую» и «фиксируюсь полностью»',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'delta'],
  note: 'Лексиконные фиксы коммита 182a273: доля берётся из текста (25%, а не дефолтные 50%), а «полностью» — это закрытие остатка, а не половина.',
  steps: [
    {
      title: 'Вход',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'LONG' }) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: 'Фиксация ровно 25%',
      post: { text: '#SOL пробит хай, 25% фиксирую' },
      expect: {
        status: 'executed',
        actions: [{ type: 'partial_close', status: 'executed', symbol: 'SOLUSDT' }],
        custom: (trace) => {
          const trade = trace.trades[0]
          const closeOrder = trace.orders.find((o) => o.purpose === 'close')
          if (!trade || !closeOrder?.qty) return ['нет закрывающего ордера с объёмом']
          const initial = new Decimal(trade.initialSize ?? trade.size)
          const closed = new Decimal(closeOrder.qty)
          const share = closed.div(initial)
          // qtyStep округляет вниз, поэтому сравниваем с допуском в один шаг лота.
          return share.minus('0.25').abs().lte('0.06')
            ? []
            : [`закрыто ${closed.toString()} из ${initial.toString()} (${share.mul(100).toFixed(1)}%), ожидали ~25%`]
        },
      },
    },
    {
      title: 'Фиксация остатка «полностью»',
      post: { text: '#SOL фиксируюсь по текущим полностью' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}

export const ch1Noise: Scenario = {
  id: 'ch1-noise',
  title: 'Шум и отрицание: обзор, «продолжаю удерживать», «не фиксирую»',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'noise'],
  note: 'Ни одно сообщение не должно породить ордер. Отдельно проверяется отрицание («не фиксирую») — до фикса лексикона оно закрывало половину позиции.',
  steps: [
    {
      title: 'Обзор рынка (шумовой ключевик)',
      post: { text: '#BTC обзор: рынок в боковике, ждём реакции на уровне' },
      expect: { status: 'noise', custom: (trace) => (trace.orders.length === 0 ? [] : ['обзор породил ордера']) },
    },
    {
      title: 'Анонс созвона',
      post: { text: 'Напоминаю: анонс — созвон в zoom завтра в 19:00' },
      expect: { status: 'noise' },
    },
    {
      title: 'Вход, чтобы было что «не фиксировать»',
      post: async (ctx) => ({ text: await entrySignal(ctx, { symbol: 'SOLUSDT', ticker: 'SOL', side: 'LONG' }) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: 'Отрицание: «ничего пока не фиксирую»',
      post: { text: '#SOL ничего пока не фиксирую, держите крепко' },
      expect: {
        custom: (trace) => {
          const forbidden = trace.actions.filter((a) => ['partial_close', 'close'].includes(a.type) && a.status === 'executed')
          return forbidden.length === 0 ? [] : [`отрицание исполнено как ${forbidden.map((a) => a.type).join(', ')} — позиция закрыта против воли автора`]
        },
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: '«Продолжаю удерживать» (hold-only)',
      post: { text: '#SOL продолжаю удерживать позицию' },
      expect: {
        status: 'noise',
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: 'Закрытие позиции',
      post: { text: '#SOL закрываю позицию полностью' },
      expect: { status: 'executed', exchange: { symbol: 'SOLUSDT', position: 'flat' } },
    },
  ],
}

export const ch1Media: Scenario = {
  id: 'ch1-media',
  title: 'Медиа: сигнал картинкой и альбом',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'media'],
  note: 'Картинка без структурного шаблона уходит в AI с needs_vision (модель смотрит график). Альбом обязан лечь одним узлом таймлайна: строки messages на каждого участника, но событие — одно, на минимальном id.',
  steps: [
    {
      title: 'Скрин графика с подписью-сигналом',
      post: async (ctx) => ({
        text: `Забираю SOL от текущих, стоп ${await ctx.offset('SOLUSDT', -5)}`,
        photo: ctx.fixture('chart-1.jpg'),
      }),
      expect: {
        custom: (trace) => {
          const problems: string[] = []
          if (!trace.message.hasMedia) problems.push('сообщение сохранено без пометки медиа')
          const det = trace.parseResults.find((p) => p.parser === 'deterministic')
          if (det && det.route !== 'ai') problems.push(`детерминированный разбор дал route='${det.route}', ожидали уход в AI`)
          if (det && !det.needsVision) problems.push('needs_vision=false — модель не получит картинку')
          return problems
        },
      },
    },
    {
      title: 'Альбом из двух графиков',
      post: (ctx) => ({ text: 'Разметка по SOL на двух таймфреймах', album: [ctx.fixture('chart-1.jpg'), ctx.fixture('chart-2.jpg')] }),
      expect: {
        custom: (trace) => (trace.message.groupedId ? [] : ['у якорного сообщения альбома нет grouped_id — таймлайн нарисует две плитки']),
      },
    },
  ],
}

export const ch1Lifecycle: Scenario = {
  id: 'ch1-lifecycle',
  title: 'Жизненный цикл сообщения: правка и удаление',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ch1', 'lifecycle'],
  requiresRealtime: true,
  note: 'Правка и удаление — реальные события Telegram, которые автор делает постоянно. Проверяем, что ingest их видит (edit_count/deleted), и фиксируем фактическое поведение движка: переобрабатывается ли правка.',
  steps: [
    {
      title: 'Обычный шумовой пост',
      post: { text: 'Смотрю за рынком, скоро будет сетап' },
      expect: { status: ['noise', 'needs_review', 'skipped'] },
    },
    {
      title: 'Правка поста: дописан торговый смысл',
      edit: { step: 0, text: 'Смотрю за рынком, скоро будет сетап. #SOL продолжаю удерживать' },
      expect: {
        custom: (trace) => (trace.message.editCount >= 1 ? [] : [`edit_count=${trace.message.editCount} — правка не доехала до БД`]),
      },
    },
    {
      title: 'Удаление поста',
      deletePost: { step: 0 },
      expect: {
        custom: (trace) => (trace.message.deleted ? [] : ['messages.deleted=false — удаление не отразилось']),
      },
    },
  ],
}
