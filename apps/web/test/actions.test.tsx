import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import type { ActionRowDto, ChannelDto } from 'shared/dto.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ActionsPage from '../src/routes/actions.js'
import { apiFetch } from '../src/lib/api.js'

const PAGE_SIZE = 50

// apiFetch замокан целиком — тест проверяет только рендер/фильтры/навигацию, без реальной сети.
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))
// useActionsStream открывает реальный socket.io-client (lib/ws.ts) — здесь это нерелевантно
// для страницы Actions per se, поэтому заглушено no-op, как useChannelStream в channels.test.tsx.
vi.mock('../src/lib/ws.js', () => ({ useActionsStream: () => {} }))

const HEADERS = ['Action', 'Pair', 'Summary', 'Trade', 'Channel', 'Time', 'Method']

const CHANNELS: ChannelDto[] = [
  {
    id: 1,
    key: 'ch-1',
    title: 'Crypto Signals VIP',
    handle: '@crypto_vip',
    initial: 'C',
    status: 'active',
    copyEnabled: true,
    winRate: '68%',
    actionCount: 2,
    activePositions: 1,
    messageCount: 10,
    tradeSize: '$500',
    maxLeverage: '10x',
    defaultLeverage: null,
    crossMargin: true,
  },
]

function actionFixture(overrides: Partial<ActionRowDto> = {}): ActionRowDto {
  return {
    id: 'a-1',
    type: 'open',
    side: 'long',
    short: 'Open',
    pair: 'BTCUSDT',
    summary: 'Open position',
    tradeRef: '#TR-1042',
    channelId: 1,
    channelName: 'Crypto Signals VIP',
    channelInitial: 'C',
    time: '2026-07-10T14:32:00.000Z',
    method: 'auto',
    skipReason: null,
    icon: 'trending-up',
    iconColor: '#34d399',
    ...overrides,
  }
}

// Пробники маршрутов назначения — проверяют факт и параметры навигации, не рендеря реальные
// (пока стаб) страницы Positions/Channel.
function PositionsProbe() {
  const location = useLocation()
  return <div data-testid="positions-probe">{location.pathname + location.search}</div>
}
function ChannelProbe() {
  const { id } = useParams()
  return <div data-testid="channel-probe">{`channel:${id}`}</div>
}

function mockApiByPath(actions: ActionRowDto[]) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/channels') return CHANNELS
    if (path.startsWith('/actions')) return actions
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
}

function renderActions(actions: ActionRowDto[]) {
  mockApiByPath(actions)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/actions']}>
        <Routes>
          <Route path="/actions" element={<ActionsPage />} />
          <Route path="/positions" element={<PositionsProbe />} />
          <Route path="/channels/:id" element={<ChannelProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ActionsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('рендерит все семь заголовков колонок', async () => {
    renderActions([actionFixture()])
    await screen.findByText('BTCUSDT')
    for (const header of HEADERS) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
  })

  it('сегмент-фильтр Type=Open отражается в URL и в запросе GET /api/actions', async () => {
    renderActions([actionFixture()])
    await screen.findByText('BTCUSDT')

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    await waitFor(() => {
      const lastActionsCall = vi
        .mocked(apiFetch)
        .mock.calls.map((c) => c[0] as string)
        .findLast((p) => p.startsWith('/actions'))
      // Task 4: keyset-пагинация — первая страница просит limit=PAGE_SIZE (курсор before
      // добавляется только при подгрузке следующей).
      expect(lastActionsCall).toBe('/actions?type=open&limit=50')
    })
  })

  it('клик по Trade #TR-1042 ведёт на /positions?tr=...', async () => {
    renderActions([actionFixture({ tradeRef: '#TR-1042' })])
    const tradeLink = await screen.findByText('Trade #TR-1042')
    fireEvent.click(tradeLink)

    const probe = await screen.findByTestId('positions-probe')
    expect(probe.textContent).toBe('/positions?tr=%23TR-1042')
  })

  it('клик по каналу ведёт на /channels/:id', async () => {
    renderActions([actionFixture({ channelId: 1, channelName: 'Crypto Signals VIP' })])
    const channelLink = await screen.findByTestId('channel-link')
    fireEvent.click(channelLink)

    expect(await screen.findByTestId('channel-probe')).toHaveTextContent('channel:1')
  })

  it('skipped-действие рендерит бейдж Skipped с тултипом = skipReason', async () => {
    renderActions([
      actionFixture({
        id: 'a-2',
        pair: null,
        tradeRef: null,
        skipReason: 'no_sl',
        icon: 'trending-up',
        iconColor: '#e5e5e5',
      }),
    ])
    const badge = await screen.findByText('Skipped')
    expect(badge).toHaveAttribute('title', 'no_sl')
  })

  // Task 6 (Ф2): needs_review — reconciler.ts помечает исход этими причинами (parser_disagreement/
  // ai_unavailable/needs_human/low_confidence), design: тот же skipped-стиль, но текст «Needs review».
  it('task-6: needs_review-причина (parser_disagreement) рендерит бейдж "Needs review" вместо "Skipped"', async () => {
    renderActions([
      actionFixture({
        id: 'a-3',
        pair: null,
        tradeRef: null,
        skipReason: 'parser_disagreement',
        icon: 'trending-up',
        iconColor: '#e5e5e5',
      }),
    ])
    const badge = await screen.findByText('Needs review')
    expect(badge).toHaveAttribute('title', 'parser_disagreement')
    expect(screen.queryByText('Skipped')).toBeNull()
  })

  // Задача 7 (приёмка форума 1962583820): 'symbol_unknown_needs_vision' — САМАЯ частая needs_review-
  // причина на реальных данных (normalize-output.ts: resolveReason(), AI не смог определить символ) —
  // task-6 её не перечислила в NEEDS_REVIEW_REASONS, обнаружено на живом прогоне этой задачей.
  it('task-7: needs_review-причина (symbol_unknown_needs_vision) рендерит бейдж "Needs review" вместо "Skipped"', async () => {
    renderActions([
      actionFixture({
        id: 'a-4',
        pair: null,
        tradeRef: null,
        skipReason: 'symbol_unknown_needs_vision',
        icon: 'trending-up',
        iconColor: '#e5e5e5',
      }),
    ])
    const badge = await screen.findByText('Needs review')
    expect(badge).toHaveAttribute('title', 'symbol_unknown_needs_vision')
    expect(screen.queryByText('Skipped')).toBeNull()
  })

  it('task-6: method="ai" рендерит текст "AI parsing" в колонке Method', async () => {
    renderActions([actionFixture({ method: 'ai' })])
    await screen.findByText('BTCUSDT')
    expect(screen.getByText('AI parsing')).toBeInTheDocument()
  })

  it('пустой список рендерит "No actions match the selected filters."', async () => {
    renderActions([])
    expect(await screen.findByText('No actions match the selected filters.')).toBeInTheDocument()
  })

  // Task 4: infinite «load more» — полная первая страница (PAGE_SIZE строк) показывает кнопку,
  // клик подгружает вторую по курсору before=<id последней строки>.
  it('«Load more» подгружает вторую страницу actions по курсору before', async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      actionFixture({ id: `a-${i}`, pair: `SYM${i}USDT` }),
    )
    const page2 = [actionFixture({ id: 'a-last', pair: 'LASTUSDT' })]
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/channels') return CHANNELS
      if (path.startsWith('/actions')) {
        const before = new URL(`http://x${path}`).searchParams.get('before')
        return before ? page2 : page1
      }
      throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/actions']}>
          <Routes>
            <Route path="/actions" element={<ActionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    await screen.findByText('SYM0USDT')
    expect(screen.queryByText('LASTUSDT')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await screen.findByText('LASTUSDT')
    expect(screen.getByText('SYM0USDT')).toBeInTheDocument()
  })

  // Important #4 финального ревью Ф1: до фикса `data ?? []` не отличал упавший запрос от
  // честного пустого списка — 401/500 рисовали то же самое "No actions match the filters.".
  it('упавший запрос GET /api/actions рендерит сообщение об ошибке, а не пустое состояние', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/channels') return CHANNELS
      if (path.startsWith('/actions')) throw new Error('boom')
      throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/actions']}>
          <Routes>
            <Route path="/actions" element={<ActionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Failed to load actions. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText('No actions match the selected filters.')).not.toBeInTheDocument()
  })
})
