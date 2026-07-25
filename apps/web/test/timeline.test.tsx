import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { MessageDto } from 'shared/dto.js'
import type { MessageNewPayload, MessageUpdatedPayload } from 'shared/ws-events.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageTimeline } from '../src/components/MessageTimeline.js'
import { apiFetch } from '../src/lib/api.js'

// apiFetch замокан целиком — тест проверяет только рендер таймлайна, без реальной сети.
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))

// socket.io-client замокан целиком: useChannelStream должен работать поверх любого сокета,
// а тест дальше сам «нажимает» на message.new через захваченный обработчик — без реального
// сетевого соединения (jsdom его всё равно не поднимет).
function createMockSocket() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}
const mockSocket = createMockSocket()
vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))

const CHANNEL_ID = 1

function messageFixture(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm-1',
    tgMessageId: 1001,
    time: '2026-07-10T12:00:00.000Z',
    text: 'ETH/USDT LONG from 3,180',
    media: [],
    aiSummary: null,
    actions: [],
    method: 'auto',
    status: 'executed',
    ...overrides,
  }
}

function renderTimeline(initial: MessageDto[]) {
  vi.mocked(apiFetch).mockResolvedValue(initial)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      {/* task-11-brief.md: таймлайн теперь рисует "Trade #TR-x" через useNavigate() (переход
          на /positions?tr=...) — компоненту нужен контекст роутера, как и во всех остальных
          страничных тестах (actions.test.tsx/positions.test.tsx/channels.test.tsx). */}
      <MemoryRouter initialEntries={['/channels/1']}>
        <MessageTimeline channelId={CHANNEL_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

// Обработчик 'message.new', зарегистрированный useChannelStream через мок-сокет —
// вызываем его напрямую, эмулируя приход события с сервера.
function getMessageNewHandler(): (payload: MessageNewPayload) => void {
  const call = mockSocket.on.mock.calls.findLast(([event]) => event === 'message.new') as
    | [string, (payload: MessageNewPayload) => void]
    | undefined
  if (!call) throw new Error("обработчик 'message.new' не зарегистрирован")
  return call[1]
}

// Обработчик 'message.updated' — правки Telegram-сообщений (задача "правки в реальном времени").
function getMessageUpdatedHandler(): (payload: MessageUpdatedPayload) => void {
  const call = mockSocket.on.mock.calls.findLast(([event]) => event === 'message.updated') as
    | [string, (payload: MessageUpdatedPayload) => void]
    | undefined
  if (!call) throw new Error("обработчик 'message.updated' не зарегистрирован")
  return call[1]
}

describe('MessageTimeline', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    mockSocket.on.mockClear()
    mockSocket.off.mockClear()
    mockSocket.emit.mockClear()
  })

  it('сообщение без действий рисует серую точку узла, а не плитку с иконкой', async () => {
    renderTimeline([messageFixture({ actions: [] })])
    const dot = await screen.findByTestId('node-dot')
    expect(dot).toBeInTheDocument()
    expect(getComputedStyle(dot).backgroundColor).toBe('rgb(58, 58, 64)')
    const tile = screen.getByTestId('node-tile')
    expect(tile.querySelector('svg')).toBeNull()
  })

  it('сообщение с media рендерит <img> с src="/media/<id>"', async () => {
    renderTimeline([
      messageFixture({ media: [{ url: '/media/abc-123', kind: 'photo' }] }),
    ])
    await screen.findByTestId('node-dot')
    const img = document.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/media/abc-123')
  })

  it('task-11 приёмка Ф1: сообщение с actions рисует строку(и) action — иконка+тип+пара+ссылка на сделку', async () => {
    renderTimeline([
      messageFixture({
        actions: [
          { type: 'open', side: 'long', pair: 'BTCUSDT', tradeRef: '#TR-1042', skipReason: null, icon: 'trending-up' },
        ],
      }),
    ])
    const row = await screen.findByTestId('timeline-action-row')
    expect(row).toHaveTextContent('Open position')
    expect(row).toHaveTextContent('BTCUSDT')
    expect(row).toHaveTextContent('Trade #TR-1042')
    // Узел рисует плитку с иконкой действия (не серую точку), раз actions непустые.
    const tile = screen.getByTestId('node-tile')
    expect(tile.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('node-dot')).toBeNull()
  })

  it('task-11 приёмка Ф1: skip_reason рисует бейдж Skipped вместо ссылки на сделку', async () => {
    renderTimeline([
      messageFixture({
        actions: [
          { type: 'open', side: null, pair: 'ETHUSDT', tradeRef: null, skipReason: 'symbol_busy', icon: 'trending-up' },
        ],
      }),
    ])
    const row = await screen.findByTestId('timeline-action-row')
    expect(row).toHaveTextContent('Skipped')
    expect(row).not.toHaveTextContent('Trade')
  })

  it('сообщение с aiSummary и пустыми actions рендерит блок саммари с иконкой sparkles', async () => {
    renderTimeline([
      messageFixture({ aiSummary: 'Информационное сообщение, сигнала нет.', actions: [] }),
    ])
    const summary = await screen.findByTestId('ai-summary')
    expect(summary).toHaveTextContent('Информационное сообщение, сигнала нет.')
    expect(summary.querySelector('svg')).not.toBeNull()
  })

  // Task 6 (Ф2): design/project/Admin.dc.html:220-238,557-558 — у сообщений С действиями
  // AI-саммари рисуется ПОД блоком actions (внутри того же "результата"), но только когда
  // method==='ai' (summaryStyle: `has && isAi && m.summary`).
  it('task-6: сообщение с actions, method="ai" и aiSummary рендерит саммари-блок под действиями', async () => {
    renderTimeline([
      messageFixture({
        method: 'ai',
        aiSummary: 'AI разобрал терсный сигнал по картинке.',
        actions: [
          { type: 'open', side: 'long', pair: 'SOLUSDT', tradeRef: '#TR-2001', skipReason: null, icon: 'trending-up' },
        ],
      }),
    ])
    const row = await screen.findByTestId('timeline-action-row')
    const summary = await screen.findByTestId('ai-summary')
    expect(summary).toHaveTextContent('AI разобрал терсный сигнал по картинке.')
    expect(summary.querySelector('svg')).not.toBeNull()
    // Саммари должен идти в DOM ПОСЛЕ строки действия (под блоком результата, design:234).
    expect(row.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('task-6: сообщение с actions и aiSummary при method="auto" НЕ рисует саммари-блок (design: только AI-разбор)', async () => {
    renderTimeline([
      messageFixture({
        method: 'auto',
        status: 'executed',
        aiSummary: 'Текст, который design не должен показывать для auto.',
        actions: [
          { type: 'open', side: 'long', pair: 'BTCUSDT', tradeRef: '#TR-3001', skipReason: null, icon: 'trending-up' },
        ],
      }),
    ])
    await screen.findByTestId('timeline-action-row')
    expect(screen.queryByTestId('ai-summary')).toBeNull()
  })

  it('task-6: action со skipReason="parser_disagreement" рендерит бейдж "Needs review" с тултипом вместо "Skipped"', async () => {
    renderTimeline([
      messageFixture({
        actions: [
          { type: 'open', side: null, pair: 'ETHUSDT', tradeRef: null, skipReason: 'parser_disagreement', icon: 'trending-up' },
        ],
      }),
    ])
    const badge = await screen.findByText('Needs review')
    expect(badge).toHaveAttribute('title', 'parser_disagreement')
    expect(screen.queryByText('Skipped')).toBeNull()
  })

  // Задача 7 (приёмка форума 1962583820): 'symbol_unknown_needs_vision' — reconciler.ts/
  // normalize-output.ts тоже маркируют needs_review этой причиной (AI не смог определить символ,
  // САМАЯ частая needs_review-причина на реальных данных), а task-6 её пропустила при написании
  // NEEDS_REVIEW_REASONS (action-display.tsx) — без этой правки бейдж молча падал на "Skipped".
  it('task-7: action со skipReason="symbol_unknown_needs_vision" тоже рендерит "Needs review", а не "Skipped"', async () => {
    renderTimeline([
      messageFixture({
        actions: [
          { type: 'open', side: null, pair: null, tradeRef: null, skipReason: 'symbol_unknown_needs_vision', icon: 'trending-up' },
        ],
      }),
    ])
    const badge = await screen.findByText('Needs review')
    expect(badge).toHaveAttribute('title', 'symbol_unknown_needs_vision')
    expect(screen.queryByText('Skipped')).toBeNull()
  })

  it("событие message.new добавляет узел в начало списка без перезагрузки", async () => {
    renderTimeline([messageFixture({ id: 'm-1', text: 'старое сообщение' })])
    await screen.findByText('старое сообщение')
    expect(screen.getAllByTestId('message-row')).toHaveLength(1)

    const handler = getMessageNewHandler()
    handler({
      channelId: CHANNEL_ID,
      message: messageFixture({ id: 'm-2', text: 'новое сообщение из сокета' }),
    })

    // findAllByTestId резолвится, как только находит ХОТЬ ОДИН элемент — уже существующая
    // строка удовлетворяет этому условию раньше, чем кэш успевает обновиться, поэтому здесь
    // нужен именно waitFor с проверкой длины, а не неявный ретрай findBy*.
    await waitFor(() => {
      expect(screen.getAllByTestId('message-row')).toHaveLength(2)
    })
    const rows = screen.getAllByTestId('message-row')
    expect(rows[0]).toHaveTextContent('новое сообщение из сокета')
    expect(rows[1]).toHaveTextContent('старое сообщение')
  })

  it('повторное message.new с тем же id не создаёт второй узел', async () => {
    renderTimeline([messageFixture({ id: 'm-1', text: 'старое сообщение' })])
    await screen.findByText('старое сообщение')

    const handler = getMessageNewHandler()
    const duplicate = messageFixture({ id: 'm-2', text: 'новое сообщение из сокета' })
    handler({ channelId: CHANNEL_ID, message: duplicate })
    await waitFor(() => {
      expect(screen.getAllByTestId('message-row')).toHaveLength(2)
    })

    handler({ channelId: CHANNEL_ID, message: duplicate })
    await waitFor(() => {
      expect(screen.getAllByTestId('message-row')).toHaveLength(2)
    })
  })

  it('событие message.updated заменяет текст существующего узла на месте, без нового узла и смены порядка', async () => {
    renderTimeline([
      messageFixture({ id: 'm-1', text: 'первое сообщение' }),
      messageFixture({ id: 'm-2', text: 'второе сообщение' }),
    ])
    await screen.findByText('первое сообщение')
    expect(screen.getAllByTestId('message-row')).toHaveLength(2)

    const handler = getMessageUpdatedHandler()
    handler({
      channelId: CHANNEL_ID,
      message: messageFixture({ id: 'm-1', text: 'первое сообщение [EDITED-CHECK]' }),
    })

    await waitFor(() => {
      expect(screen.getByText('первое сообщение [EDITED-CHECK]')).toBeInTheDocument()
    })
    // Ровно два узла (не три — правка заменяет, а не добавляет) и порядок не сдвинулся:
    // отредактированное сообщение по-прежнему первое.
    const rows = screen.getAllByTestId('message-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('первое сообщение [EDITED-CHECK]')
    expect(rows[1]).toHaveTextContent('второе сообщение')
  })

  it('message.updated для id, отсутствующего в кэше, ничего не ломает', async () => {
    renderTimeline([messageFixture({ id: 'm-1', text: 'старое сообщение' })])
    await screen.findByText('старое сообщение')

    const handler = getMessageUpdatedHandler()
    handler({
      channelId: CHANNEL_ID,
      message: messageFixture({ id: 'm-не-в-кэше', text: 'узел, которого нет в таймлайне' }),
    })

    // Ни новый узел не появился, ни существующий не пострадал.
    await waitFor(() => {
      expect(screen.getAllByTestId('message-row')).toHaveLength(1)
    })
    expect(screen.getByText('старое сообщение')).toBeInTheDocument()
    expect(screen.queryByText('узел, которого нет в таймлайне')).toBeNull()
  })
})

// Правки по итогам живой эксплуатации: (1) сообщение прилетает по WS сразу, а действия и AI-саммари
// движок дописывает секундами позже — до этого узел был неотличим от «шума», и оператор перезагружал
// страницу; (2) у пропущенных действий на экране был безликий бейдж «Skipped» без причины.
describe('MessageTimeline — разбор в процессе и причины пропуска', () => {
  it('сообщение ещё разбирается -> лоадер вместо действий/саммари', async () => {
    renderTimeline([messageFixture({ status: 'received', actions: [], aiSummary: null })])

    expect(await screen.findByTestId('message-pending')).toBeInTheDocument()
    expect(screen.getByText(/Parsing message/)).toBeInTheDocument()
  })

  it('разбор закончен -> лоадера нет, видны действия', async () => {
    renderTimeline([
      messageFixture({
        status: 'executed',
        actions: [{ type: 'open', side: 'long', pair: 'BTCUSDT', tradeRef: '#TR-1', skipReason: null, icon: 'trending-up' }],
      }),
    ])

    await screen.findByTestId('timeline-action-row')
    expect(screen.queryByTestId('message-pending')).not.toBeInTheDocument()
  })

  it('пропущенное действие показывает ПРИЧИНУ текстом, а не только бейдж Skipped', async () => {
    renderTimeline([
      messageFixture({
        status: 'skipped',
        actions: [{ type: 'open', side: 'long', pair: 'SOLUSDT', tradeRef: null, skipReason: 'no_SL', icon: 'trending-up' }],
      }),
    ])

    await screen.findByText('Skipped')
    expect(screen.getByText('no stop-loss')).toBeInTheDocument()
  })

  it('needs_review-причина: бейдж Needs review + расшифровка', async () => {
    renderTimeline([
      messageFixture({
        status: 'needs_review',
        actions: [{ type: 'open', side: null, pair: null, tradeRef: null, skipReason: 'ai_unavailable', icon: 'trending-up' }],
      }),
    ])

    await screen.findByText('Needs review')
    expect(screen.getByText('AI unavailable')).toBeInTheDocument()
  })
})
