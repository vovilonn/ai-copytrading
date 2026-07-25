import type { Scenario } from '../scenario.js'

/**
 * Операционные сценарии: поведение системы вокруг ДЕЙСТВИЙ ОПЕРАТОРА, а не сообщений канала.
 * Их нельзя проверить юнит-тестом — нужен живой стек и живая биржа.
 */

export const opsCopyDisabled: Scenario = {
  id: 'ops-copy-disabled',
  title: 'Выключенное копирование: сигнал разбирается, но ордера не уходят',
  slot: 1,
  symbols: ['SOLUSDT'],
  tags: ['ops', 'guards'],
  note: 'Тумблер channel_settings.enabled — главный «стоп-кран» оператора. Сообщение обязано разобраться и попасть в таблицу действий (иначе оператор не поймёт, что бот проигнорировал), но ExecutionPort вызываться не должен.',
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
        status: 'executed',
        actions: [{ type: 'open', status: 'skipped', symbol: 'SOLUSDT', skipReason: 'copy_disabled' }],
        exchange: { symbol: 'SOLUSDT', position: 'flat', openOrdersMax: 0 },
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
