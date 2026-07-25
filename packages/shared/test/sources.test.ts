import { describe, it, expect } from 'vitest'
import { CHANNEL_SOURCES, parseChannelOverrides, resolveChannelSources } from '../src/sources.js'

describe('resolveChannelSources — тестовый режим (TG_CHANNEL_OVERRIDES)', () => {
  it('оверрайд не задан -> боевые каналы', () => {
    expect(resolveChannelSources({})).toEqual(CHANNEL_SOURCES)
    expect(resolveChannelSources({ TG_CHANNEL_OVERRIDES: '' })).toEqual(CHANNEL_SOURCES)
    expect(resolveChannelSources({ TG_CHANNEL_OVERRIDES: '   ' })).toEqual(CHANNEL_SOURCES)
  })

  it('подменённый канал наследует адаптер боевого — разбирается тем же парсером', () => {
    const sources = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '1=2999999999,2=2888888888' })

    expect(sources).toHaveLength(2)
    expect(sources[0]!.channelId).toBe(2999999999n)
    expect(sources[0]!.adapterId).toBe('ch1-structured') // regex-канал
    expect(sources[1]!.channelId).toBe(2888888888n)
    expect(sources[1]!.adapterId).toBe('ch2-freeform') // AI-канал
  })

  // Боевые каналы при активном оверрайде НЕ слушаются: иначе живой сигнал открыл бы реальную
  // сделку посреди теста.
  it('оверрайд ЗАМЕЩАЕТ список: боевых каналов в источниках не остаётся', () => {
    const sources = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '1=2999999999' })

    expect(sources).toHaveLength(1)
    const ids = sources.map((s) => s.channelId)
    expect(ids).not.toContain(CHANNEL_SOURCES[0]!.channelId)
    expect(ids).not.toContain(CHANNEL_SOURCES[1]!.channelId)
  })

  it('обычный канал (без топика) -> sourceKind=channel, topicId=null', () => {
    const [source] = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '2=2888888888' })

    // Боевой ch2 — форум-топик, но ВАШ тестовый канал обычный: фильтр по топику применяться не должен,
    // иначе topicOf() отбросит все сообщения как 'other' и в БД не попадёт ничего.
    expect(source!.sourceKind).toBe('channel')
    expect(source!.topicId).toBeNull()
  })

  it('топик указан -> sourceKind=forum_topic с этим топиком', () => {
    const [source] = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '2=2888888888:173666' })

    expect(source!.sourceKind).toBe('forum_topic')
    expect(source!.topicId).toBe(173666)
  })

  // channels.ord UNIQUE, а строки боевых каналов остаются в БД со своей историей сообщений.
  it('ord тестовых каналов смещён — не конфликтует с боевыми строками в БД', () => {
    const sources = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '1=2999999999,2=2888888888' })

    const bootOrds = CHANNEL_SOURCES.map((s) => s.ord)
    for (const source of sources) {
      expect(bootOrds).not.toContain(source.ord)
    }
  })

  it('key тестового канала свой — медиа не смешивается с боевым', () => {
    const [source] = resolveChannelSources({ TG_CHANNEL_OVERRIDES: '1=2999999999' })

    expect(source!.key).toBe('test-2999999999')
    expect(CHANNEL_SOURCES.map((s) => s.key)).not.toContain(source!.key)
  })

  describe('ошибки конфигурации падают на старте, а не игнорируются молча', () => {
    it('несуществующий ord', () => {
      expect(() => parseChannelOverrides('9=123')).toThrow(/нет канала с ord=9/)
    })

    it('битый формат', () => {
      expect(() => parseChannelOverrides('123456')).toThrow(/ожидался формат/)
    })

    it('id с префиксом -100 (частая ошибка) — не молча, а с объяснением', () => {
      expect(() => parseChannelOverrides('1=-1002999999999')).toThrow(/без -100/)
    })
  })
})
