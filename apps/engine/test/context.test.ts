import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Kysely, sql } from 'kysely'
import { resetTestSchema } from 'test-db'
import { createDb, type DB } from 'api/db/database.js'
import { migrateToLatest } from 'api/db/migrate.js'
import type { Side } from 'shared/domain.js'
import { openTrade, addLeg } from '../src/state/trades.js'
import { DryRunAdapter } from '../src/execution/dry-run.adapter.js'
import { buildContext, hashOpenPositions } from '../src/ai/context.js'

// buildContext (задача 2 Ф2, research/ai-layer.md §4.4/§9/§10): против реальной copytrade_test,
// тот же приём сборки сценария (message->action->trade->leg->DryRunAdapter), что и
// dry-run.adapter.test.ts (задача 6).

let db: Kysely<DB>
const adapter = new DryRunAdapter()

const CHANNEL_ID = 1
const CHANNEL_ORD = 1

// Реальный файл дампа (используется и в ai-client.test.ts) — карточка WEEX SOLUSDT '2🎯'.
const SOL_CARD_STORAGE_PATH = 'var/media/ch-1962583820-t173666/221437_0.jpg'
const SOL_CARD_ABS_PATH = fileURLToPath(new URL('../../../var/media/ch-1962583820-t173666/221437_0.jpg', import.meta.url))

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)
  await sql`
    INSERT INTO channels (id, ord, key, source_kind, adapter_id) VALUES (${CHANNEL_ID}, ${CHANNEL_ORD}, 'ch2', 'channel', 'ch2')
  `.execute(db)
})

afterAll(async () => {
  await db.destroy()
})

let tgMessageSeq = 500000

async function seedMessage(params: { text?: string; replyToMsgId?: number | null } = {}): Promise<{
  messageId: string
  tgMessageId: number
}> {
  const tgMessageId = tgMessageSeq++
  const row = await db
    .insertInto('messages')
    .values({
      channel_id: CHANNEL_ID,
      tg_message_id: tgMessageId,
      reply_to_msg_id: params.replyToMsgId ?? null,
      is_topic_message: false,
      text: params.text ?? '',
      has_media: false,
      msg_ts: new Date(),
      raw: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { messageId: row.id, tgMessageId }
}

async function seedAction(params: { messageId: string; symbol: string; side: Side }): Promise<string> {
  const row = await db
    .insertInto('actions')
    .values({
      message_id: params.messageId,
      channel_id: CHANNEL_ID,
      action_index: 0,
      type: 'open',
      side: params.side,
      symbol: params.symbol,
      method: 'auto',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

/** message -> action -> trade -> entry-лега (та же связка, что и dry-run.adapter.test.ts). */
async function setupTradeContext(
  symbol: string,
  side: Side,
): Promise<{ tgMessageId: number; actionId: string; tradeId: string; legId: string }> {
  const { messageId, tgMessageId } = await seedMessage()
  const actionId = await seedAction({ messageId, symbol, side })
  const trade = await openTrade(db, { channelId: CHANNEL_ID, symbol, side, openedMsgId: messageId })
  const leg = await addLeg(db, { tradeId: trade.tradeId, legIndex: 0, kind: 'entry', requestedQty: '1' })
  return { tgMessageId, actionId, tradeId: trade.tradeId, legId: leg.legId }
}

describe('buildContext — открытые позиции (§4.4)', () => {
  it('позиция с добором + TP-лесенкой + SL=avg_price -> легс=1, sl="BE", tpsLeft по возрастанию', async () => {
    const ctx = await setupTradeContext('AAAUSDT', 'long')

    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'AAAUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '10',
      price: '100',
      leverage: '5',
      liqPrice: '80',
    })

    // Добор — отдельная лега kind='add' (§4.4 "число доборов" — считает legs в context.ts).
    await addLeg(db, { tradeId: ctx.tradeId, legIndex: 1, kind: 'add', requestedQty: '5' })

    await adapter.placeTpLadder(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 1,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'AAAUSDT',
      side: 'long',
      tps: [
        { price: '120', qty: '5', index: 1 },
        { price: '110', qty: '5', index: 0 },
      ],
    })

    await adapter.setStopLoss(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 2,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'AAAUSDT',
      side: 'long',
      price: '100', // = avg_price -> безубыток
      qty: '10',
    })

    const { messageId } = await seedMessage()
    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })

    const pos = built.openPositions.find((p) => p.sym === 'AAAUSDT')
    expect(pos).toBeDefined()
    expect(pos).toMatchObject({
      sym: 'AAAUSDT',
      side: 'long',
      legs: 1,
      avgEntry: 100,
      sl: 'BE',
      tpsLeft: [110, 120], // по возрастанию tp_index, а не по порядку вставки
      opened: ctx.tgMessageId,
    })
  })

  it('позиция с числовым SL, без доборов и TP -> legs=0, sl=число, tpsLeft=[]', async () => {
    const ctx = await setupTradeContext('BBBUSDT', 'short')

    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'BBBUSDT',
      side: 'short',
      purpose: 'entry',
      orderType: 'market',
      qty: '1',
      price: '50',
      leverage: '3',
      liqPrice: '65',
    })

    await adapter.setStopLoss(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 1,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      symbol: 'BBBUSDT',
      side: 'short',
      price: '55',
      qty: '1',
    })

    const { messageId } = await seedMessage()
    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })

    const pos = built.openPositions.find((p) => p.sym === 'BBBUSDT')
    expect(pos).toMatchObject({ side: 'short', legs: 0, avgEntry: 50, sl: 55, tpsLeft: [] })
  })

  it('позиция без SL вовсе -> sl="none"', async () => {
    const ctx = await setupTradeContext('CCCUSDT', 'long')
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'CCCUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '1',
      price: '1',
      leverage: '2',
      liqPrice: '0.5',
    })

    const { messageId } = await seedMessage()
    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })

    const pos = built.openPositions.find((p) => p.sym === 'CCCUSDT')
    expect(pos).toMatchObject({ sl: 'none', tpsLeft: [] })
  })

  it('openPositionsHash детерминирован и меняется при изменении снимка позиций', async () => {
    const { messageId } = await seedMessage()
    const first = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    const second = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(first.openPositionsHash).toBe(second.openPositionsHash)
    expect(first.openPositionsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.openPositionsHash).toBe(hashOpenPositions(first.openPositions))

    // Новая позиция появляется в канале -> снимок другой -> другой хэш.
    const ctx = await setupTradeContext('DDDUSDT', 'long')
    await adapter.placeEntry(db, {
      channelId: CHANNEL_ID,
      channelOrd: CHANNEL_ORD,
      tgMessageId: ctx.tgMessageId,
      actionIndex: 0,
      actionId: ctx.actionId,
      tradeId: ctx.tradeId,
      legId: ctx.legId,
      symbol: 'DDDUSDT',
      side: 'long',
      purpose: 'entry',
      orderType: 'market',
      qty: '1',
      price: '1',
      leverage: '2',
      liqPrice: '0.5',
    })
    const third = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(third.openPositionsHash).not.toBe(first.openPositionsHash)
  })
})

describe('buildContext — reply-parent текст', () => {
  it('извлекает текст родителя по reply_to_msg_id ВНУТРИ того же канала', async () => {
    const parent = await seedMessage({ text: 'Теперь есть такой таргет' })
    const child = await seedMessage({ text: 'Стоп на твх', replyToMsgId: parent.tgMessageId })

    const built = await buildContext(db, { id: child.messageId, channelId: CHANNEL_ID, replyToMsgId: parent.tgMessageId })
    expect(built.replyParentText).toBe('Теперь есть такой таргет')
  })

  it('replyToMsgId=null -> replyParentText не задан', async () => {
    const { messageId } = await seedMessage()
    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(built.replyParentText).toBeUndefined()
  })

  // Живой случай 09.08.2026: «Sol 1🎯» <- «2🎯» <- «3🎯». Символ назван ОДИН раз, в корне ветки, и
  // на втором хопе прежний контекст (ровно один родитель) его терял — тейк по солане ушёл на биток.
  it('цепочка терсных реплик: предки выше родителя доезжают до модели, символ ветки вычисляется', async () => {
    const root = await seedMessage({ text: 'Sol 1🎯\nNext - 75.7, 77.2' })
    const middle = await seedMessage({ text: '2🎯', replyToMsgId: root.tgMessageId })
    const last = await seedMessage({ text: '3🎯', replyToMsgId: middle.tgMessageId })

    const built = await buildContext(db, { id: last.messageId, channelId: CHANNEL_ID, replyToMsgId: middle.tgMessageId })

    expect(built.replyParentText).toBe('2🎯')
    expect(built.replyChain).toEqual(['Sol 1🎯\nNext - 75.7, 77.2'])
    expect(built.replyChainSymbol).toBe('SOLUSDT')
  })

  it('ближайший предок с символами называет их НЕСКОЛЬКО -> подсказки нет (не гадаем)', async () => {
    const root = await seedMessage({ text: 'Sl btc 60000, Sl Eth 1800' })
    const child = await seedMessage({ text: '2🎯', replyToMsgId: root.tgMessageId })

    const built = await buildContext(db, { id: child.messageId, channelId: CHANNEL_ID, replyToMsgId: root.tgMessageId })

    expect(built.replyChainSymbol).toBeUndefined()
    expect(built.replyParentText).toBe('Sl btc 60000, Sl Eth 1800')
  })

  it('цикл в данных (сообщение отвечает само себе) не вешает сборку контекста', async () => {
    const { messageId, tgMessageId } = await seedMessage({ text: '3🎯' })
    await db.updateTable('messages').set({ reply_to_msg_id: tgMessageId }).where('id', '=', messageId).execute()

    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: tgMessageId })

    expect(built.replyParentText).toBe('3🎯')
    expect(built.replyChain).toBeUndefined()
  })
})

describe('buildContext — картинки message_media', () => {
  it('кодирует реальный файл дампа в base64 (совпадает byte-in-byte с диском)', async () => {
    const { messageId, tgMessageId } = await seedMessage({ text: '2🎯' })
    await db
      .insertInto('message_media')
      .values({
        id: randomUUID(),
        message_id: messageId,
        tg_message_id: tgMessageId,
        grouped_id: null,
        order_index: 0,
        storage_path: SOL_CARD_STORAGE_PATH,
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        created_at: new Date(),
      })
      .execute()

    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })

    expect(built.images).toHaveLength(1)
    const expectedBase64 = readFileSync(SOL_CARD_ABS_PATH).toString('base64')
    expect(built.images[0]).toEqual({ base64: expectedBase64, mediaType: 'image/jpeg' })
  })

  it('несуществующий файл на диске -> картинка молча пропускается (не падает)', async () => {
    const { messageId, tgMessageId } = await seedMessage()
    await db
      .insertInto('message_media')
      .values({
        id: randomUUID(),
        message_id: messageId,
        tg_message_id: tgMessageId,
        grouped_id: null,
        order_index: 0,
        storage_path: 'var/media/does-not-exist/ghost.jpg',
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        created_at: new Date(),
      })
      .execute()

    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(built.images).toEqual([])
  })

  it('нет message_media -> images=[]', async () => {
    const { messageId } = await seedMessage()
    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(built.images).toEqual([])
  })

  it('Minor #3 адверсариального ревью: storage_path="../../etc/passwd" (выход за var/media) -> картинка пропущена', async () => {
    const { messageId, tgMessageId } = await seedMessage()
    await db
      .insertInto('message_media')
      .values({
        id: randomUUID(),
        message_id: messageId,
        tg_message_id: tgMessageId,
        grouped_id: null,
        order_index: 0,
        storage_path: '../../etc/passwd',
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        created_at: new Date(),
      })
      .execute()

    const built = await buildContext(db, { id: messageId, channelId: CHANNEL_ID, replyToMsgId: null })
    expect(built.images).toEqual([]) // контейнмент отсёк выход за var/media — файл НЕ прочитан
  })
})
