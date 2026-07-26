import type { Scenario } from '../scenario.js'

/**
 * Операционные сценарии: поведение системы вокруг ДЕЙСТВИЙ ОПЕРАТОРА, а не сообщений канала.
 * Их нельзя проверить юнит-тестом — нужен живой стек и живая биржа.
 */

export const opsCopyDisabled: Scenario = {
  id: 'ops-copy-disabled',
  title: 'Выключенное копирование: сообщение не разбирается вовсе',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ops', 'guards'],
  note: 'Тумблер channel_settings.enabled — главный «стоп-кран» оператора: у выключенного канала сообщение НЕ разбирается вовсе (ни парсером, ни моделью) и уходит в skipped(copy_disabled). Так выключенный канал перестаёт стоить денег — раньше разбор шёл полностью и жёг AI.',
  steps: [
    {
      title: 'Оператор выключает копирование и присылает сигнал',
      act: async (ctx) => {
        await ctx.ops.setCopyEnabled(false)
      },
      post: async (ctx) => ({
        text: [
          '#SOL/USDT 📈 LONG',
          '',
          `Диапазон входа: ${await ctx.offset('SOLUSDT', -0.1)}-${await ctx.offset('SOLUSDT', 0.1)}$`,
          '',
          `TP: ${await ctx.offset('SOLUSDT', 3)}$`,
          '',
          `SL: ${await ctx.offset('SOLUSDT', -5)}$`,
        ].join('\n'),
      }),
      expect: {
        status: 'skipped',
        reason: 'copy_disabled',
        actions: [],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
        custom: (trace) => {
          const problems: string[] = []
          if (trace.parseResults.length > 0) problems.push('выключенный канал всё равно разобран — разбор должен был не запускаться')
          if (trace.aiCalls.length > 0) problems.push(`выключенный канал позвал модель ${trace.aiCalls.length} раз(а) — это прямые деньги на ветер`)
          return problems
        },
      },
    },
    {
      title: 'Оператор включает копирование обратно',
      act: async (ctx) => {
        await ctx.ops.setCopyEnabled(true)
      },
    },
  ],
}

export const opsManualClose: Scenario = {
  id: 'ops-manual-close',
  title: 'Ручное закрытие позиции на бирже мимо бота',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ops'],
  note: 'Оператор закрыл позицию руками в интерфейсе Bybit. Движок обязан увидеть это приватным WS: закрыть сделку в журнале, обнулить зеркало позиции и пометить сделку manual_override — иначе следующая дельта канала будет управлять несуществующей позицией.',
  steps: [
    {
      title: 'Вход по сигналу',
      post: async (ctx) => ({
        text: [
          '#SOL/USDT 📈 LONG',
          '',
          `Диапазон входа: ${await ctx.offset('SOLUSDT', -0.1)}-${await ctx.offset('SOLUSDT', 0.1)}$`,
          '',
          `TP: ${await ctx.offset('SOLUSDT', 3)}$ - ${await ctx.offset('SOLUSDT', 6)}$`,
          '',
          `SL: ${await ctx.offset('SOLUSDT', -5)}$`,
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT' }],
        exchange: { symbol: 'SOLUSDT', position: 'long', stopLoss: true },
      },
    },
    {
      title: 'Оператор закрывает позицию руками на бирже',
      act: async (ctx) => {
        await ctx.ops.closeOnExchange('SOLUSDT')
      },
      // Зеркало обновляется пушем приватного WS — даём ему время.
      settleMs: 45_000,
      expect: {
        position: { symbol: 'SOLUSDT', side: 'flat' },
        exchange: { symbol: 'SOLUSDT', position: 'flat' },
      },
    },
    {
      title: 'Дельта канала по уже закрытой позиции',
      post: { text: '#SOL зафиксировал 50%' },
      expect: {
        status: 'executed',
        actions: [{ type: 'partial_close', status: 'skipped', symbol: 'SOLUSDT', skipReason: 'no_open_position' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat' },
      },
    },
  ],
}

/**
 * Два канала торгуют ОДНОВРЕМЕННО, каждый на своём символе — проверка субаккаунтов
 * (docs/superpowers/specs/2026-07-26-per-channel-subaccounts-design.md).
 *
 * В прогоне обоим тестовым каналам прописаны ОДНИ И ТЕ ЖЕ demo-креды: это имитация двух
 * субаккаунтов на одной demo-бирже (демо-субаккаунтов у Bybit нет) и одновременно самый строгий
 * случай — движок обязан обслуживать их ОДНИМ рантаймом (один REST + один приватный WS). Два
 * соединения с одинаковыми кредами получали бы одни и те же пуши, и каждый филл обработался бы
 * дважды; а атрибуция без скоупа могла бы приписать позицию не тому каналу.
 *
 * Что ловим: пуш аккаунта уходит в ПРАВИЛЬНЫЙ канал (зеркало и сделки не перемешались), и обе
 * позиции живут на бирже одновременно, не мешая друг другу.
 */
export const opsTwoChannels: Scenario = {
  id: 'ops-two-channels',
  title: 'Два канала одновременно: сделки и зеркала не перепутались между каналами',
  slot: 1,
  symbols: ['ADAUSDT', 'XRPUSDT'],
  tags: ['ops', 'subaccounts'],
  note: 'Обоим каналам прописаны одни demo-креды (имитация двух субаккаунтов). Канал 1 входит в ADA, канал 2 — в XRP; проверяется, что каждый канал видит ТОЛЬКО свою позицию и свою сделку, а обе позиции живут на бирже одновременно.',
  steps: [
    {
      title: 'Канал 1 входит в ADA',
      post: async (ctx) => ({
        text: [
          '#ADA/USDT 📈 LONG',
          '',
          `Диапазон входа: ${await ctx.offset('ADAUSDT', -0.1)}-${await ctx.offset('ADAUSDT', 0.1)}$`,
          '',
          `TP: ${await ctx.offset('ADAUSDT', 3)}$`,
          '',
          `SL: ${await ctx.offset('ADAUSDT', -5)}$`,
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'ADAUSDT', side: 'long' }],
        position: { symbol: 'ADAUSDT', side: 'long', size: 'gt0' },
        exchange: { symbol: 'ADAUSDT', position: 'long', stopLoss: true },
      },
    },
    {
      title: 'Канал 2 входит в XRP, пока позиция канала 1 открыта',
      slot: 2,
      post: async (ctx) => ({
        text: [
          '#XRPUSDT LONG',
          `Entry price: ${await ctx.offset('XRPUSDT', -0.1)} - ${await ctx.offset('XRPUSDT', 0.1)}`,
          `Targets: 1️⃣${await ctx.offset('XRPUSDT', 3)}`,
          `Stop loss: ${await ctx.offset('XRPUSDT', -5)}`,
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        actions: [{ type: 'open', status: 'executed', symbol: 'XRPUSDT', side: 'long' }],
        position: { symbol: 'XRPUSDT', side: 'long', size: 'gt0' },
        exchange: { symbol: 'XRPUSDT', position: 'long', stopLoss: true },
        custom: async (_trace, ctx) => {
          const problems: string[] = []
          const [ch1Positions, ch2Positions, ch1Trades, ch2Trades] = await Promise.all([
            ctx.channelState.positions(1, ['ADAUSDT', 'XRPUSDT']),
            ctx.channelState.positions(2, ['ADAUSDT', 'XRPUSDT']),
            ctx.channelState.trades(1, ['ADAUSDT', 'XRPUSDT']),
            ctx.channelState.trades(2, ['ADAUSDT', 'XRPUSDT']),
          ])

          const live = (rows: { symbol: string; size: string }[]): string[] =>
            rows.filter((row) => Number(row.size) !== 0).map((row) => row.symbol)
          const open = (rows: { symbol: string; status: string }[]): string[] =>
            rows.filter((row) => row.status === 'open' || row.status === 'partially_closed').map((row) => row.symbol)

          const ch1Live = live(ch1Positions)
          const ch2Live = live(ch2Positions)
          if (!ch1Live.includes('ADAUSDT')) problems.push('у канала 1 нет живого зеркала ADAUSDT — его собственная позиция потерялась')
          if (ch1Live.includes('XRPUSDT')) problems.push('канал 1 получил зеркало XRPUSDT — пуш чужого канала приписан ему')
          if (!ch2Live.includes('XRPUSDT')) problems.push('у канала 2 нет живого зеркала XRPUSDT — его собственная позиция потерялась')
          if (ch2Live.includes('ADAUSDT')) problems.push('канал 2 получил зеркало ADAUSDT — пуш чужого канала приписан ему')

          const ch1Open = open(ch1Trades)
          const ch2Open = open(ch2Trades)
          if (ch1Open.includes('XRPUSDT')) problems.push('в канале 1 открыта сделка по XRPUSDT — сделка ушла не в тот канал')
          if (ch2Open.includes('ADAUSDT')) problems.push('в канале 2 открыта сделка по ADAUSDT — сделка ушла не в тот канал')
          return problems
        },
      },
    },
    {
      title: 'Канал 1 закрывает свою позицию — позиция канала 2 не должна пострадать',
      post: { text: '#ADA закрываю полностью' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'ADAUSDT' }],
        exchange: { symbol: 'ADAUSDT', position: 'flat', openOrdersMax: 0 },
        custom: async (_trace, ctx) => {
          const positions = await ctx.channelState.positions(2, ['XRPUSDT'])
          const alive = positions.some((row) => Number(row.size) !== 0)
          return alive ? [] : ['закрытие канала 1 обнулило зеркало канала 2 — cancelAll/закрытие задели чужой символ']
        },
      },
    },
    {
      title: 'Канал 2 закрывает свою позицию',
      slot: 2,
      post: { text: 'Закрываю XRP полностью, забираем профит' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'XRPUSDT' }],
        exchange: { symbol: 'XRPUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}
