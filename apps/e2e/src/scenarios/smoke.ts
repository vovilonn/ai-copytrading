import type { Scenario } from '../scenario.js'

/**
 * Дымовой сценарий: самый короткий путь «пост → ордер на бирже → закрытие».
 *
 * Держим его отдельно от каталога кейсов: он проверяет не поведение бота, а саму ПЕТЛЮ e2e
 * (постинг от юзербота, доезд до БД, обработка движком, реальный ордер на demo, зеркало позиции).
 * Если он красный — остальные сценарии запускать бессмысленно, чинить надо инфраструктуру.
 *
 * Цены берутся живыми (ctx.offset): цели обязаны остаться по прибыльную сторону от рынка, иначе
 * вход штатно уходит в skipped(targets_passed) — гейт слиппеджа по умолчанию выключен, и от
 * протухшего сигнала защищают именно цели (pipeline.ts::handleOpen).
 */
export const smokeCh1: Scenario = {
  id: 'smoke-ch1',
  title: 'Структурный сигнал → вход, фиксация половины, закрытие остатка',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['smoke', 'ch1'],
  note: 'Проверка самой петли: пост юзербота → tg-ingest → engine → реальный ордер на Bybit demo.',
  steps: [
    {
      title: 'Вход по структурному сигналу',
      post: async (ctx) => ({
        text: [
          '#SOL/USDT 📈 LONG',
          '',
          `Диапазон входа: ${await ctx.offset('SOLUSDT', -0.1)}-${await ctx.offset('SOLUSDT', 0.1)}$`,
          '',
          `TP: ${await ctx.offset('SOLUSDT', 3)}$ - ${await ctx.offset('SOLUSDT', 6)}$`,
          '',
          `SL: ${await ctx.offset('SOLUSDT', -5)}$`,
          '',
          'Риск: 2%',
        ].join('\n'),
      }),
      expect: {
        status: 'executed',
        method: 'auto',
        actions: [{ type: 'open', status: 'executed', symbol: 'SOLUSDT', side: 'long', skipReason: null }],
        orders: [
          { purpose: 'entry', count: 1 },
          { purpose: 'sl', count: 1 },
          { purpose: 'tp', count: 2 },
        ],
        position: { symbol: 'SOLUSDT', side: 'long', size: 'gt0', stopLossSet: true },
        exchange: { symbol: 'SOLUSDT', position: 'long', stopLoss: true, openOrdersMin: 2 },
      },
    },
    {
      title: 'Фиксация половины ответом на сигнал',
      post: (ctx) => ({ text: '#SOL зафиксировал 50%, остальное держим', replyTo: ctx.postedId(0) }),
      expect: {
        status: 'executed',
        actions: [{ type: 'partial_close', status: 'executed', symbol: 'SOLUSDT' }],
        position: { symbol: 'SOLUSDT', side: 'long', size: 'gt0' },
        exchange: { symbol: 'SOLUSDT', position: 'long' },
      },
    },
    {
      title: 'Закрытие остатка',
      post: { text: '#SOL закрываю позицию полностью' },
      expect: {
        status: 'executed',
        actions: [{ type: 'close', status: 'executed', symbol: 'SOLUSDT' }],
        position: { symbol: 'SOLUSDT', side: 'flat' },
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
      },
    },
  ],
}
