import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { Kysely } from 'kysely'
import { resetTestSchema } from 'test-db'
import type { ChannelDto, MessageDto } from 'shared/dto.js'
import { CHANNEL_SOURCES } from 'shared/sources.js'
import { createDb, type DB } from '../src/db/database.js'
import { migrateToLatest } from '../src/db/migrate.js'
import { createApp } from '../src/app.js'

// message_media.storage_path хранится относительно корня репозитория (см.
// apps/api/src/channels/media.controller.ts) — фикстура пишется туда же, в var/ (gitignore),
// чтобы проверить именно резолв относительного пути, как в проде.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE_REL_PATH = 'var/media/test-fixture/media.jpg'

const ADMIN_USERNAME = process.env.ADMIN_USERNAME!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!

// Те же 2 канала, что сидирует ChannelSeedService при старте приложения (см.
// apps/api/src/channels/channel-seed.service.ts) и apps/tg-ingest/src/ingest.service.ts —
// оба берут их из единого источника packages/shared/src/sources.ts.
const CHANNEL_1_ID = Number(CHANNEL_SOURCES[0]!.channelId)
const CHANNEL_1_KEY = CHANNEL_SOURCES[0]!.key
const CHANNEL_2_KEY = CHANNEL_SOURCES[1]!.key

let app: INestApplication
let db: Kysely<DB>
let agent: ReturnType<typeof request.agent>

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL!)
  await migrateToLatest(db)
  await resetTestSchema(db)

  app = await createApp()
  await app.init() // ChannelSeedService сидирует 2 канала, AuthService — админа

  // Фикстуры сообщений создаём сами (бриф: не полагаться на dev-данные) поверх засеянного канала.
  for (let i = 1; i <= 5; i++) {
    await db
      .insertInto('messages')
      .values({
        channel_id: CHANNEL_1_ID,
        tg_message_id: 1000 + i,
        is_topic_message: false,
        text: `сигнал #${i}`,
        has_media: false,
        msg_ts: new Date(Date.UTC(2026, 0, 1, 12, i, 0)),
        raw: JSON.stringify({}),
      })
      .execute()
  }

  agent = request.agent(app.getHttpServer())
  await agent.post('/api/auth/login').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }).expect(204)
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

it('GET /channels без куки -> 401', async () => {
  const res = await request(app.getHttpServer()).get('/api/channels')
  expect(res.status).toBe(401)
})

it('GET /channels возвращает оба засеянных канала', async () => {
  const res = await agent.get('/api/channels').expect(200)
  const channels = res.body as ChannelDto[]
  expect(channels).toHaveLength(2)
  expect(channels.map((c) => c.key).sort()).toEqual([CHANNEL_2_KEY, CHANNEL_1_KEY].sort())

  const ch1 = channels.find((c) => c.key === CHANNEL_1_KEY)!
  expect(ch1.id).toBe(CHANNEL_1_ID)
  expect(ch1.winRate).toBe('—')
  expect(ch1.tradeSize).toBe('$500')
  expect(ch1.maxLeverage).toBe('10x')
  expect(ch1.messageCount).toBe(5)
  expect(ch1.actionCount).toBe(0)
  expect(ch1.activePositions).toBe(0)
  expect(typeof ch1.initial).toBe('string')
  expect(ch1.initial.length).toBe(1)
})

it('channels.handle пуст в БД -> фолбэк "#<id>" (приватный канал без username)', async () => {
  // ChannelSeedService всегда сидирует handle: null (без доступа к Telegram) — оба тестовых
  // канала попадают под фолбэк, пока их никто не обновил.
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}`).expect(200)
  const channel = res.body as ChannelDto
  expect(channel.handle).toBe(`#${CHANNEL_1_ID}`)
})

it('GET /channels/:id отдаёт один канал в том же формате', async () => {
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}`).expect(200)
  const channel = res.body as ChannelDto
  expect(channel.id).toBe(CHANNEL_1_ID)
  expect(channel.key).toBe(CHANNEL_1_KEY)
})

it('GET /channels/999999 -> 404', async () => {
  await agent.get('/api/channels/999999').expect(404)
})

it('GET /channels/:id/messages?limit=3 отдаёт ровно 3 записи по убыванию tgMessageId', async () => {
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=3`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages).toHaveLength(3)
  const ids = messages.map((m) => m.tgMessageId)
  expect(ids).toEqual([1005, 1004, 1003])
  for (const m of messages) {
    expect(m.actions).toEqual([])
    expect(Array.isArray(m.media)).toBe(true)
    expect(() => new Date(m.time).toISOString()).not.toThrow()
  }
})

it('GET /channels/:id/messages?limit=3&before=1004 продолжает пагинацию', async () => {
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=3&before=1004`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages.map((m) => m.tgMessageId)).toEqual([1003, 1002, 1001])
})

it('GET /channels/:id/messages с некорректными limit/before откатывается к дефолту, а не 500', async () => {
  const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=abc&before=xyz`).expect(200)
  const messages = res.body as MessageDto[]
  expect(messages.map((m) => m.tgMessageId)).toEqual([1005, 1004, 1003, 1002, 1001])
})

// Дефект Ф0 (task-12c): Telegram доставляет альбом N отдельными строками messages с общим
// grouped_id — API обязан склеивать их в один узел таймлайна (один MessageDto, N media),
// а не отдавать N плиток с одной фотографией на каждой. Якорь узла — сообщение с МИНИМАЛЬНЫМ
// tg_message_id в группе (на его id/tgMessageId держится монотонная пагинация по before=).
describe('альбом (grouped_id) — один узел таймлайна с несколькими фото', () => {
  const ALBUM_GROUPED_ID = '999888777666555'
  // Выше одиночных фикстур (1001..1005) — альбом становится самым новым узлом ленты.
  const ALBUM_BASE_TG_ID = 2000

  beforeAll(async () => {
    // 3 сообщения одного альбома: подпись Telegram кладёт ровно на ОДНО сообщение группы
    // (здесь — среднее по tg_message_id), у остальных text = ''.
    for (let i = 0; i < 3; i++) {
      await db
        .insertInto('messages')
        .values({
          channel_id: CHANNEL_1_ID,
          tg_message_id: ALBUM_BASE_TG_ID + i,
          grouped_id: ALBUM_GROUPED_ID,
          is_topic_message: false,
          text: i === 1 ? 'подпись альбома' : '',
          has_media: true,
          msg_ts: new Date(Date.UTC(2026, 0, 2, 12, i, 0)),
          raw: JSON.stringify({}),
        })
        .execute()
    }

    const albumMessages = await db
      .selectFrom('messages')
      .select(['id', 'tg_message_id'])
      .where('channel_id', '=', CHANNEL_1_ID)
      .where('grouped_id', '=', ALBUM_GROUPED_ID)
      .orderBy('tg_message_id', 'asc')
      .execute()

    // Строка message_media лежит на КОНКРЕТНОМ сообщении-члене группы (order_index — позиция
    // внутри альбома) — раздача самого файла тут не проверяется, поэтому storage_path условный.
    for (const [i, m] of albumMessages.entries()) {
      await db
        .insertInto('message_media')
        .values({
          id: crypto.randomUUID(),
          message_id: m.id,
          tg_message_id: m.tg_message_id,
          grouped_id: ALBUM_GROUPED_ID,
          order_index: i,
          storage_path: `var/media/test-fixture/album_${i}.jpg`,
          media_type: 'image/jpeg',
          width: null,
          height: null,
          bytes: 10 + i,
          sha256: null,
          created_at: new Date(),
        })
        .execute()
    }
  })

  it('альбом из трёх сообщений отдаётся одним MessageDto с тремя media, tgMessageId = min группы, text = единственная подпись', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=50`).expect(200)
    const messages = res.body as MessageDto[]

    const albumNode = messages.find((m) => m.tgMessageId === ALBUM_BASE_TG_ID)
    expect(albumNode).toBeDefined()
    expect(albumNode!.media).toHaveLength(3)
    expect(albumNode!.text).toBe('подпись альбома')

    // Остальные tg_message_id группы НЕ порождают собственных узлов — иначе альбом
    // по-прежнему рисовался бы тремя плитками вместо одной.
    expect(messages.some((m) => m.tgMessageId === ALBUM_BASE_TG_ID + 1)).toBe(false)
    expect(messages.some((m) => m.tgMessageId === ALBUM_BASE_TG_ID + 2)).toBe(false)
  })

  it('limit=2 при данных «альбом(3) + одиночное» отдаёт ровно 2 узла таймлайна (лимит по узлам, не по строкам messages)', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=2`).expect(200)
    const messages = res.body as MessageDto[]
    expect(messages).toHaveLength(2)
    expect(messages[0]!.tgMessageId).toBe(ALBUM_BASE_TG_ID) // самый новый узел — альбом (3 строки, 1 узел)
    expect(messages[1]!.tgMessageId).toBe(1005) // следующий узел — одиночное сообщение
  })

  it('одиночные сообщения не изменились: у них ровно один узел на строку messages, media не смешивается с чужими', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=50`).expect(200)
    const messages = res.body as MessageDto[]
    for (const tgId of [1001, 1002, 1003, 1004, 1005]) {
      const node = messages.find((m) => m.tgMessageId === tgId)
      expect(node).toBeDefined()
      expect(node!.media).toEqual([])
    }
  })
})

describe('GET /media/:id', () => {
  let mediaId: string
  const fixtureBytes = Buffer.from('fake-jpeg-bytes')

  beforeAll(async () => {
    const message = await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', CHANNEL_1_ID)
      .where('tg_message_id', '=', 1001)
      .executeTakeFirstOrThrow()

    const absPath = path.join(REPO_ROOT, FIXTURE_REL_PATH)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, fixtureBytes)

    const row = await db
      .insertInto('message_media')
      .values({
        id: crypto.randomUUID(),
        message_id: message.id,
        tg_message_id: 1001,
        grouped_id: null,
        order_index: 0,
        storage_path: FIXTURE_REL_PATH,
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: fixtureBytes.length,
        sha256: null,
        created_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    mediaId = row.id
  })

  afterAll(async () => {
    await fs.rm(path.join(REPO_ROOT, 'var/media/test-fixture'), { recursive: true, force: true })
  })

  it('отдаёт файл по storage_path потоком с корректным Content-Type', async () => {
    const res = await agent.get(`/api/media/${mediaId}`).expect(200)
    expect(res.headers['content-type']).toContain('image/jpeg')
    expect(Buffer.from(res.body as Buffer).equals(fixtureBytes)).toBe(true)
  })

  it('без куки -> 401', async () => {
    const res = await request(app.getHttpServer()).get(`/api/media/${mediaId}`)
    expect(res.status).toBe(401)
  })

  it('несуществующий id -> 404', async () => {
    await agent.get('/api/media/00000000-0000-0000-0000-000000000000').expect(404)
  })

  it('некорректный (не-UUID) id -> 404, а не 500', async () => {
    await agent.get('/api/media/not-a-uuid').expect(404)
  })

  // Path traversal (защита в глубину, финальное ревью): storage_path пишет только воркер
  // константными путями, но если в колонке однажды окажется значение с "..", контроллер не должен
  // отдавать файл наружу файловой системы репозитория.
  it('storage_path с "../../etc/passwd" -> 404, а не содержимое файла вне var/media', async () => {
    const row = await db
      .insertInto('message_media')
      .values({
        id: crypto.randomUUID(),
        message_id: (
          await db
            .selectFrom('messages')
            .select('id')
            .where('channel_id', '=', CHANNEL_1_ID)
            .where('tg_message_id', '=', 1001)
            .executeTakeFirstOrThrow()
        ).id,
        tg_message_id: 1001,
        grouped_id: null,
        order_index: 1,
        storage_path: '../../etc/passwd',
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        created_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await agent.get(`/api/media/${row.id}`).expect(404)
  })

  // Абсолютный storage_path тоже не должен отдаваться как есть (см. media.controller.ts).
  it('storage_path = "/etc/passwd" (абсолютный) -> 404', async () => {
    const row = await db
      .insertInto('message_media')
      .values({
        id: crypto.randomUUID(),
        message_id: (
          await db
            .selectFrom('messages')
            .select('id')
            .where('channel_id', '=', CHANNEL_1_ID)
            .where('tg_message_id', '=', 1001)
            .executeTakeFirstOrThrow()
        ).id,
        tg_message_id: 1001,
        grouped_id: null,
        order_index: 2,
        storage_path: '/etc/passwd',
        media_type: 'image/jpeg',
        width: null,
        height: null,
        bytes: null,
        sha256: null,
        created_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await agent.get(`/api/media/${row.id}`).expect(404)
  })
})

// Задача 8: actions пайплайна (задача 7) теперь заполняют MessageDto.actions — раньше был [].
// Блок намеренно в конце файла: tg_message_id фикстуры выше остальных фикстур этого файла
// (1001-1005, альбом 2000-2002) — если вставить его раньше, он "всплывёт" самым свежим узлом
// в предыдущих describe-блоках и сломает их проверки точного порядка/лимита узлов.
describe('MessageDto.actions — заполняется из таблицы actions (задача 8)', () => {
  const SIGNAL_TG_ID = 9000

  beforeAll(async () => {
    const message = await db
      .insertInto('messages')
      .values({
        channel_id: CHANNEL_1_ID,
        tg_message_id: SIGNAL_TG_ID,
        is_topic_message: false,
        text: '#BTC/USDT Long\nEntry 62400\nTP 64000\nSL 61500',
        has_media: false,
        msg_ts: new Date(Date.UTC(2026, 0, 3, 12, 0, 0)),
        raw: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const trade = await db
      .insertInto('trades')
      .values({ human_ref: 'TR-9201', seq: 9201, channel_id: CHANNEL_1_ID, symbol: 'BTCUSDT', side: 'long', status: 'open' })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('actions')
      .values({
        message_id: message.id,
        channel_id: CHANNEL_1_ID,
        action_index: 0,
        type: 'open',
        side: 'long',
        symbol: 'BTCUSDT',
        pair: 'BTCUSDT',
        method: 'auto',
        status: 'executed',
        trade_id: trade.id,
      })
      .execute()
  })

  it('сообщение с распознанным сигналом отдаёт actions с иконкой/типом/pair/tradeRef', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=50`).expect(200)
    const messages = res.body as MessageDto[]
    const signal = messages.find((m) => m.tgMessageId === SIGNAL_TG_ID)!
    expect(signal.actions).toHaveLength(1)
    const action = signal.actions[0]!
    expect(action.type).toBe('open')
    expect(action.side).toBe('long')
    expect(action.pair).toBe('BTCUSDT')
    expect(action.tradeRef).toBe('#TR-9201')
    expect(action.skipReason).toBeNull()
    expect(action.icon).toBe('trending-up')
  })

  it('сообщение без сигнала по-прежнему отдаёт actions: []', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_1_ID}/messages?limit=50`).expect(200)
    const messages = res.body as MessageDto[]
    const noSignal = messages.find((m) => m.tgMessageId === 1005)!
    expect(noSignal.actions).toEqual([])
  })
})

// Задача Win Rate (Ф4, task-2-brief.md): closedTrades/wins считаются из trades.status='closed'/
// is_win; cancelled (неисполнившаяся лимитка — не результат) исключён из знаменателя.
// CHANNEL_2 (не CHANNEL_1) — изоляция от фикстур CHANNEL_1 выше (тест 'GET /channels...'
// уже проверил ch1.winRate === '—' на канале без единой закрытой сделки).
describe('Win Rate — статистика закрытых сделок (задача Win Rate, Ф4)', () => {
  const CHANNEL_2_ID = Number(CHANNEL_SOURCES[1]!.channelId)
  let seq = 700_000

  async function seedClosedTrade(status: 'closed' | 'cancelled', isWin: boolean | null): Promise<void> {
    const n = seq++
    await db
      .insertInto('trades')
      .values({
        human_ref: `TR-WR-${n}`,
        seq: n,
        channel_id: CHANNEL_2_ID,
        symbol: 'BTCUSDT',
        side: 'long',
        status,
        is_win: isWin,
        closed_at: new Date(),
      })
      .execute()
  }

  beforeAll(async () => {
    // 2 из 3 ЗАКРЫТЫХ сделок прибыльны (win) -> round(2/3*100) = 67% (пример дословно из брифа).
    await seedClosedTrade('closed', true)
    await seedClosedTrade('closed', true)
    await seedClosedTrade('closed', false)
    // cancelled — неисполнившаяся лимитка: НЕ должна попасть в знаменатель (иначе было бы 2/4=50%).
    await seedClosedTrade('cancelled', null)
  })

  it('GET /channels/:id -> winRate = "67%" (2 из 3 закрытых прибыльны), cancelled не искажает знаменатель', async () => {
    const res = await agent.get(`/api/channels/${CHANNEL_2_ID}`).expect(200)
    const channel = res.body as ChannelDto
    expect(channel.winRate).toBe('67%')
  })

  it('GET /channels -> тот же канал в общем списке отдаёт тот же winRate', async () => {
    const res = await agent.get('/api/channels').expect(200)
    const channels = res.body as ChannelDto[]
    const ch2 = channels.find((c) => c.id === CHANNEL_2_ID)!
    expect(ch2.winRate).toBe('67%')
  })

  // Адверсариал-ревью I1: закрытая сделка с is_win=NULL (dry-run не считает realized_pnl —
  // исход НЕИЗВЕСТЕН) не должна тянуть winRate вниз. Со старой формулой (знаменатель = все
  // закрытые) стало бы 2/4=50%; с исправленной (знаменатель = только решённые) остаётся 2/3=67%.
  it('closed-сделка с is_win=NULL исключена из знаменателя — winRate остаётся 67%, а не падает до 50%', async () => {
    await seedClosedTrade('closed', null)
    const res = await agent.get(`/api/channels/${CHANNEL_2_ID}`).expect(200)
    expect((res.body as ChannelDto).winRate).toBe('67%')
  })
})
