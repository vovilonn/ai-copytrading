import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import type { ChannelDto, PositionDto, PositionStatsDto } from 'shared/dto.js'
import type { PositionUpsertPayload } from 'shared/ws-events.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PositionsPage from '../src/routes/positions.js'
import { apiFetch } from '../src/lib/api.js'

// apiFetch замокан целиком — тест проверяет только рендер/фильтры/реалтайм, без реальной сети.
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))

// socket.io-client замокан целиком (тот же приём, что timeline.test.tsx): usePositionsStream
// регистрирует обработчик 'position.upsert' через io(), тест «нажимает» на него напрямую.
function createMockSocket() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn() }
}
const mockSocket = createMockSocket()
vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))

const HEADERS = [
  'Symbol',
  'Side',
  'Size',
  'Entry',
  'Mark',
  'Liq. price',
  'Unreal. PnL',
  'TP / SL',
  'Leverage',
  'Source',
]

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

function positionFixture(overrides: Partial<PositionDto> = {}): PositionDto {
  return {
    id: '1:BTCUSDT',
    symbol: 'BTCUSDT',
    side: 'long',
    size: '0.42',
    entry: '62400',
    mark: '63180',
    liq: '58900',
    unrealisedPnl: '+$327.60',
    roi: '+6.2%',
    tp: '65500',
    sl: '61500',
    leverage: '5x',
    marginMode: 'Cross',
    source: 'Crypto Signals VIP',
    tradeRef: '#TR-1042',
    channelId: 1,
    ...overrides,
  }
}

function statsFixture(overrides: Partial<PositionStatsDto> = {}): PositionStatsDto {
  return {
    openPositions: 1,
    unrealisedPnl: '+$327.60',
    positionValue: '$26,535',
    marginUsed: '$5,307',
    // Task 1 (мониторинг PnL/баланса): поля добавлены в PositionStatsDto ради компиляции;
    // buildStats() их пока не читает — реальный рендер добавит Task 4.
    realizedPnl: '0',
    totalPnl: '0',
    ...overrides,
  }
}

function ChannelProbe() {
  const { id } = useParams()
  return <div data-testid="channel-probe">{`channel:${id}`}</div>
}

function mockApiByPath(positions: PositionDto[], stats: PositionStatsDto) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/channels') return CHANNELS
    if (path === '/positions/stats') return stats
    // Секция Pending (задача 3, Ф4) живёт на этой же странице и шлёт свой GET независимо от
    // фильтров Positions — этот файл её не тестирует (см. pending.test.tsx), поэтому пустой
    // список по умолчанию, чтобы не мешать существующим ассертам Positions.
    if (path === '/orders/pending') return []
    if (path.startsWith('/positions')) return positions
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
}

function renderPositions(
  positions: PositionDto[],
  stats: PositionStatsDto = statsFixture(),
  initialEntry = '/positions',
) {
  mockApiByPath(positions, stats)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/positions" element={<PositionsPage />} />
          <Route path="/channels/:id" element={<ChannelProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function getPositionUpsertHandler(): (payload: PositionUpsertPayload) => void {
  const call = mockSocket.on.mock.calls.findLast(([event]) => event === 'position.upsert') as
    | [string, (payload: PositionUpsertPayload) => void]
    | undefined
  if (!call) throw new Error("обработчик 'position.upsert' не зарегистрирован")
  return call[1]
}

function positionsCallCount(): number {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter(([p]) => typeof p === 'string' && p.startsWith('/positions') && p !== '/positions/stats').length
}

describe('PositionsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    mockSocket.on.mockClear()
    mockSocket.off.mockClear()
    mockSocket.emit.mockClear()
  })

  it('рендерит 4 стат-карточки из stats, PnL зелёный при плюсе', async () => {
    renderPositions([positionFixture()], statsFixture({ unrealisedPnl: '+$327.60' }))
    await screen.findByText('BTCUSDT')

    expect(screen.getByText('Open positions')).toBeInTheDocument()
    expect(screen.getByText('Unrealised PnL')).toBeInTheDocument()
    expect(screen.getByText('Position value')).toBeInTheDocument()
    expect(screen.getByText('Margin used')).toBeInTheDocument()

    const pnlValue = screen.getByTestId('stat-value-Unrealised PnL')
    expect(pnlValue).toHaveTextContent('+$327.60')
    expect(pnlValue).toHaveClass('text-long')
    expect(pnlValue).not.toHaveClass('text-short')
  })

  it('PnL красный при минусе', async () => {
    renderPositions([positionFixture()], statsFixture({ unrealisedPnl: '-$45.00' }))
    await screen.findByText('BTCUSDT')

    const pnlValue = screen.getByTestId('stat-value-Unrealised PnL')
    expect(pnlValue).toHaveTextContent('-$45.00')
    expect(pnlValue).toHaveClass('text-short')
    expect(pnlValue).not.toHaveClass('text-long')
  })

  it('рендерит все десять заголовков колонок таблицы', async () => {
    renderPositions([positionFixture()])
    await screen.findByText('BTCUSDT')
    // Секция Pending (задача 3, Ф4) добавляет свою таблицу на ту же страницу — с частично
    // совпадающими названиями колонок (Symbol/Side тоже есть у Pending), поэтому скоупим
    // поиск именно на таблицу Positions (первая в DOM), а не на весь screen.
    const [positionsTable] = screen.getAllByRole('table')
    for (const header of HEADERS) {
      expect(within(positionsTable!).getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
  })

  it('?tr=#TR-1042 предзаполняет поиск', async () => {
    renderPositions([positionFixture()], statsFixture(), '/positions?tr=%23TR-1042')
    await screen.findByText('BTCUSDT')

    const input = await screen.findByPlaceholderText('Symbol, channel or #TR-ID…')
    await waitFor(() => {
      expect(input).toHaveValue('#TR-1042')
    })
  })

  it('position.upsert точечно обновляет mark/PnL строки без нового GET /api/positions', async () => {
    renderPositions([positionFixture()])
    await screen.findByText('BTCUSDT')
    expect(screen.getByText('63180')).toBeInTheDocument()

    const callsBefore = positionsCallCount()

    const handler = getPositionUpsertHandler()
    handler({
      channelId: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      size: '0.42',
      avgPrice: '62400',
      markPrice: '64000',
      leverage: '5',
      stopLoss: '61500',
      tradeId: 'trade-1',
    })

    // (64000-62400)*0.42 = 672; margin = (0.42*64000)/5 = 5376; roi = 672/5376*100 = 12.5%
    await waitFor(() => {
      expect(screen.getByText('64000')).toBeInTheDocument()
    })
    expect(screen.getByText('+$672.00')).toBeInTheDocument()
    expect(screen.getByText('+12.5%')).toBeInTheDocument()
    expect(screen.queryByText('63180')).not.toBeInTheDocument()

    // Точечный патч — ни одного дополнительного GET /api/positions после события сокета.
    expect(positionsCallCount()).toBe(callsBefore)
  })

  it('position.upsert с size=0 убирает закрытую позицию из таблицы', async () => {
    renderPositions([positionFixture()])
    await screen.findByText('BTCUSDT')

    const handler = getPositionUpsertHandler()
    handler({
      channelId: 1,
      symbol: 'BTCUSDT',
      side: 'long',
      size: '0',
      avgPrice: '62400',
      markPrice: '64000',
      leverage: '5',
      stopLoss: null,
      tradeId: 'trade-1',
    })

    await waitFor(() => {
      expect(screen.getByText('No positions match the selected filters.')).toBeInTheDocument()
    })
  })

  it('пустой список рендерит "No positions match the selected filters."', async () => {
    renderPositions([])
    expect(await screen.findByText('No positions match the selected filters.')).toBeInTheDocument()
  })

  it('клик по источнику ведёт на /channels/:id', async () => {
    renderPositions([positionFixture({ channelId: 1 })])
    const sourceLink = await screen.findByTestId('position-source')
    sourceLink.click()

    expect(await screen.findByTestId('channel-probe')).toHaveTextContent('channel:1')
  })

  // Important #4 финального ревью Ф1: до фикса `data ?? []` не отличал упавший запрос от
  // честного пустого списка — 401/500 рисовали то же самое "No positions match the filters.".
  it('упавший запрос GET /api/positions рендерит сообщение об ошибке, а не пустое состояние', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/channels') return CHANNELS
      if (path === '/positions/stats') return statsFixture()
      if (path === '/orders/pending') return []
      if (path.startsWith('/positions')) throw new Error('boom')
      throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/positions']}>
          <Routes>
            <Route path="/positions" element={<PositionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Failed to load positions. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText('No positions match the selected filters.')).not.toBeInTheDocument()
  })
})
