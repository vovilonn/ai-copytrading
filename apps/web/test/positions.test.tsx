import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import type {
  AccountWalletDto,
  ChannelDto,
  ChannelPnlDto,
  ClosedTradeDto,
  PositionDto,
  PositionStatsDto,
} from 'shared/dto.js'
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
    tps: ['65500'],
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
    realizedPnl: '+$120.00',
    totalPnl: '+$447.60',
    ...overrides,
  }
}

const WALLET: AccountWalletDto = {
  totalEquity: '$10,000.00',
  availableBalance: '$8,500.00',
  currency: 'USDT',
  asOf: '2026-07-12T10:00:00.000Z',
  perChannel: [],
}

const BY_CHANNEL: ChannelPnlDto[] = [
  {
    channelId: 1,
    channelTitle: 'Crypto Signals VIP',
    openPositions: 1,
    unrealisedPnl: '+$327.60',
    realizedPnl: '+$120.00',
    totalPnl: '+$447.60',
    winRate: '68%',
  },
]

function closedTradeFixture(overrides: Partial<ClosedTradeDto> = {}): ClosedTradeDto {
  return {
    tradeRef: 'TR-2001',
    channelId: 1,
    channelTitle: 'Crypto Signals VIP',
    symbol: 'ETHUSDT',
    side: 'long',
    avgEntry: '3180',
    exitPrice: '3260',
    realizedPnl: '+$240.00',
    isWin: true,
    closeReason: 'tp',
    leverage: '5x',
    openedAt: '2026-07-11T08:00:00.000Z',
    closedAt: '2026-07-11T10:14:00.000Z',
    durationMs: 2 * 60 * 60 * 1000 + 14 * 60 * 1000,
    status: 'closed',
    ...overrides,
  }
}

function ChannelProbe() {
  const { id } = useParams()
  return <div data-testid="channel-probe">{`channel:${id}`}</div>
}

interface MockOpts {
  history?: ClosedTradeDto[]
  wallet?: AccountWalletDto
  byChannel?: ChannelPnlDto[]
  /** Постраничный ответ /positions по курсору before — иначе один и тот же массив на все страницы. */
  positionsByCursor?: (before: string | null) => PositionDto[]
}

function mockApiByPath(positions: PositionDto[], stats: PositionStatsDto, opts: MockOpts = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/channels') return CHANNELS
    if (path === '/positions/stats') return stats
    if (path === '/positions/stats/by-channel') return opts.byChannel ?? BY_CHANNEL
    if (path === '/account/wallet') return opts.wallet ?? WALLET
    if (path.startsWith('/positions/history')) return opts.history ?? []
    // Секция Pending (задача 3, Ф4) живёт на этой же странице и шлёт свой GET независимо от
    // фильтров Positions — этот файл её не тестирует (см. pending.test.tsx), поэтому пустой
    // список по умолчанию, чтобы не мешать существующим ассертам Positions.
    if (path === '/orders/pending') return []
    if (path === '/positions' || path.startsWith('/positions?')) {
      if (opts.positionsByCursor) {
        const before = new URL(`http://x${path}`).searchParams.get('before')
        return opts.positionsByCursor(before)
      }
      return positions
    }
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
}

function renderPositions(
  positions: PositionDto[],
  stats: PositionStatsDto = statsFixture(),
  initialEntry = '/positions',
  opts: MockOpts = {},
) {
  mockApiByPath(positions, stats, opts)
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

// Считает ТОЛЬКО обращения к списку открытых позиций (эндпоинт /positions), не путая их с
// /positions/stats, /positions/stats/by-channel и /positions/history (тоже начинаются с /positions).
function positionsListCallCount(): number {
  return vi
    .mocked(apiFetch)
    .mock.calls.filter(([p]) => typeof p === 'string' && (p === '/positions' || p.startsWith('/positions?'))).length
}

describe('PositionsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    mockSocket.on.mockClear()
    mockSocket.off.mockClear()
    mockSocket.emit.mockClear()
  })

  it('рендерит стат-карточки из stats, PnL зелёный при плюсе', async () => {
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

  // Task 4: глобальные PnL-карточки realized/total добавлены поверх исходной четвёрки.
  it('рендерит карточки Realized PnL и Total PnL, красит по знаку', async () => {
    renderPositions([positionFixture()], statsFixture({ realizedPnl: '-$50.00', totalPnl: '+$277.60' }))
    await screen.findByText('BTCUSDT')

    const realized = screen.getByTestId('stat-value-Realized PnL')
    expect(realized).toHaveTextContent('-$50.00')
    expect(realized).toHaveClass('text-short')

    const total = screen.getByTestId('stat-value-Total PnL')
    expect(total).toHaveTextContent('+$277.60')
    expect(total).toHaveClass('text-long')
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
    // Несколько таблиц на странице (PnL по каналам, Positions, Pending) — скоупим поиск на
    // таблицу Positions по её уникальному заголовку 'Liq. price'.
    const positionsTable = screen.getByRole('columnheader', { name: 'Liq. price' }).closest('table')!
    for (const header of HEADERS) {
      expect(within(positionsTable).getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
  })

  it('?tr=#TR-1042 предзаполняет поиск БЕЗ решётки — иначе по нему ничего не находится', async () => {
    // В UI сделка показана как «#TR-1042» (решётку добавляет бэкенд), но в БД human_ref хранится
    // без неё и поиск матчит `human_ref ILIKE` — с решёткой переход в позицию открывал пустой список.
    renderPositions([positionFixture()], statsFixture(), '/positions?tr=%23TR-1042')
    await screen.findByText('BTCUSDT')

    const input = await screen.findByPlaceholderText('Symbol, channel or #TR-ID…')
    await waitFor(() => {
      expect(input).toHaveValue('TR-1042')
    })
  })

  // Task 4: infinite «load more» — первая страница (50 строк) + кнопка подгружает вторую по
  // курсору before=<id последней строки>, без перезагрузки первой.
  it('«Load more» подгружает вторую страницу позиций по курсору before', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      positionFixture({ id: `1:SYM${i}`, symbol: `SYM${i}`, channelId: 1 }),
    )
    const page2 = [positionFixture({ id: '1:LASTCOIN', symbol: 'LASTCOIN', channelId: 1 })]
    renderPositions([], statsFixture(), '/positions', {
      positionsByCursor: (before) => (before ? page2 : page1),
    })

    await screen.findByText('SYM0')
    expect(screen.queryByText('LASTCOIN')).not.toBeInTheDocument()
    expect(positionsListCallCount()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await screen.findByText('LASTCOIN')
    // Первая страница осталась на месте, вторая догрузилась — всего два обращения к списку.
    expect(screen.getByText('SYM0')).toBeInTheDocument()
    expect(positionsListCallCount()).toBe(2)
  })

  // Task 4: вкладка Closed — клик по сегменту переключает на таблицу закрытых сделок.
  it('вкладка Closed рендерит закрытые сделки из /positions/history', async () => {
    renderPositions([positionFixture()], statsFixture(), '/positions', {
      history: [closedTradeFixture()],
    })
    await screen.findByText('BTCUSDT')

    fireEvent.click(screen.getByRole('button', { name: 'Closed' }))

    // Открытая позиция ушла, показана закрытая сделка с realized PnL, бейджем причины и Win.
    await screen.findByText('ETHUSDT')
    expect(screen.queryByText('BTCUSDT')).not.toBeInTheDocument()
    expect(screen.getByText('+$240.00')).toBeInTheDocument()
    expect(screen.getByText('TP')).toBeInTheDocument()
    expect(screen.getByText('Win')).toBeInTheDocument()
    expect(screen.getByText('2h 14m')).toBeInTheDocument()
  })

  // Регрессия: TP выставляется лесенкой reduce-only лимиток, а не trading-stop'ом позиции, поэтому
  // positions.take_profit пуст — раньше карточка показывала «TP —» при реально висящих на бирже целях
  // (в список отложенных reduce-only ордера тоже не попадают by design → TP не было видно НИГДЕ).
  it('карточка позиции показывает всю активную TP-лесенку, а не одну цель', async () => {
    renderPositions([positionFixture({ tp: '79.47', tps: ['79.47', '82.52'], sl: '72.59' })])
    await screen.findByText('BTCUSDT')

    expect(screen.getByText('TP 79.47 / 82.52')).toBeInTheDocument()
    expect(screen.getByText('SL 72.59')).toBeInTheDocument()
  })

  it('TP-лесенки нет (TP выставлен на самой позиции) -> показывается TP позиции', async () => {
    renderPositions([positionFixture({ tp: '65500', tps: [], sl: '61500' })])
    await screen.findByText('BTCUSDT')

    expect(screen.getByText('TP 65500')).toBeInTheDocument()
  })

  it('position.upsert точечно обновляет mark/PnL строки без нового GET /api/positions', async () => {
    renderPositions([positionFixture()])
    await screen.findByText('BTCUSDT')
    expect(screen.getByText('63180')).toBeInTheDocument()

    const callsBefore = positionsListCallCount()

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
    expect(positionsListCallCount()).toBe(callsBefore)
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

  // F7 (адверсариал-ревью): страница ровно из pageSize (50) строк, hasNextPage=true. Одна из
  // строк ЭТОЙ (последней загруженной) страницы закрывается (size=0) и удаляется из кэша
  // локально — без рефетча длина страницы упала бы до 49 и useCursorList::getNextPageParam
  // (page.length < pageSize) ошибочно решил бы, что дальше страниц нет: кнопка «Load more»
  // пропала бы, а вторая, ещё не загруженная страница стала бы недостижимой.
  it('F7: size=0 на последней полной странице не прячет «Load more» — рефетч восстанавливает границу', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      positionFixture({ id: `1:SYM${i}`, symbol: `SYM${i}`, channelId: 1 }),
    )
    renderPositions([], statsFixture(), '/positions', {
      // Сервер уже отражает закрытие; в этом тесте страница остаётся полной (например, её
      // «дозаполнила» соседняя строка) — так асерт про «Load more» бьёт именно по логике
      // hasNextPage, а не по случайному совпадению длины.
      positionsByCursor: (before) => (before ? [] : page1),
    })

    await screen.findByText('SYM0')
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
    expect(positionsListCallCount()).toBe(1)

    const handler = getPositionUpsertHandler()
    handler({
      channelId: 1,
      symbol: 'SYM0',
      side: 'long',
      size: '0',
      avgPrice: '62400',
      markPrice: '64000',
      leverage: '5',
      stopLoss: null,
      tradeId: 'trade-1',
    })

    // Троттлленный рефетч списка сработал (F7-фикс) — второй GET /api/positions.
    await waitFor(() => {
      expect(positionsListCallCount()).toBe(2)
    })
    // ...и после него граница страниц восстановлена — «Load more» всё ещё на месте.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
    })
  })

  // F9 (адверсариал-ревью): вкладка Open, активный фильтр side=long; прилетает upsert, который
  // разворачивает строку в short. patchPositionRow патчит строку НА МЕСТЕ внутри уже
  // отфильтрованной (по side=long) страницы, не проверяя фильтр — без фикса строка осталась бы
  // висеть под неверным фильтром. Фикс дёргает тот же listFallback, что и unmatched-тики —
  // проверяем именно это (доп. GET /api/positions), а не полный набор поведений бэкенд-фильтра.
  it('F9: реверс side у строки под активным фильтром side=long триггерит рефетч списка', async () => {
    renderPositions([positionFixture({ side: 'long' })], statsFixture(), '/positions?side=long')
    await screen.findByText('BTCUSDT')
    const callsBefore = positionsListCallCount()

    const handler = getPositionUpsertHandler()
    handler({
      channelId: 1,
      symbol: 'BTCUSDT',
      side: 'short',
      size: '0.42',
      avgPrice: '62400',
      markPrice: '64000',
      leverage: '5',
      stopLoss: '61500',
      tradeId: 'trade-1',
    })

    await waitFor(() => {
      expect(positionsListCallCount()).toBeGreaterThan(callsBefore)
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
      if (path === '/positions/stats/by-channel') return BY_CHANNEL
      if (path === '/account/wallet') return WALLET
      if (path === '/orders/pending') return []
      if (path === '/positions' || path.startsWith('/positions?')) throw new Error('boom')
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
