import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ClosedTradeDto } from 'shared/dto.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClosedTradesTable, formatDuration } from '../src/components/ClosedTradesTable.js'
import { apiFetch } from '../src/lib/api.js'

vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))

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

function renderTable(pageByCursor: (before: string | null) => ClosedTradeDto[]) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/positions/history')) {
      const before = new URL(`http://x${path}`).searchParams.get('before')
      return pageByCursor(before)
    }
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ClosedTradesTable />
    </QueryClientProvider>,
  )
}

describe('formatDuration', () => {
  it('форматирует минуты/часы/дни без секунд', () => {
    expect(formatDuration(14 * 60 * 1000)).toBe('14m')
    expect(formatDuration(2 * 60 * 60 * 1000 + 14 * 60 * 1000)).toBe('2h 14m')
    expect(formatDuration(3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe('3d 5h')
    expect(formatDuration(0)).toBe('0m')
  })
})

describe('ClosedTradesTable', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('рендерит закрытую сделку: realized PnL, длительность, бейдж причины TP и Win', async () => {
    renderTable(() => [closedTradeFixture()])
    await screen.findByText('ETHUSDT')

    expect(screen.getByText('3180')).toBeInTheDocument()
    expect(screen.getByText('3260')).toBeInTheDocument()
    const pnl = screen.getByText('+$240.00')
    expect(pnl).toHaveClass('text-long')
    expect(screen.getByText('TP')).toBeInTheDocument()
    expect(screen.getByText('2h 14m')).toBeInTheDocument()
    expect(screen.getByText('Win')).toBeInTheDocument()
  })

  it('убыточная сделка красит realized PnL красным и рисует Loss', async () => {
    renderTable(() => [
      closedTradeFixture({ tradeRef: 'TR-3', realizedPnl: '-$88.00', isWin: false, closeReason: 'sl' }),
    ])
    await screen.findByText('ETHUSDT')

    expect(screen.getByText('-$88.00')).toHaveClass('text-short')
    expect(screen.getByText('SL')).toBeInTheDocument()
    expect(screen.getByText('Loss')).toBeInTheDocument()
  })

  it('cancelled-сделка: бейдж Cancelled, отсутствующий exit — «—», исход «—» при isWin=null', async () => {
    renderTable(() => [
      closedTradeFixture({
        tradeRef: 'TR-4',
        exitPrice: null,
        realizedPnl: '+$0.00',
        isWin: null,
        closeReason: 'cancelled',
        status: 'cancelled',
      }),
    ])
    await screen.findByText('ETHUSDT')

    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    // exit «—» и result «—» — две прочерк-ячейки в строке.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('liquidation и manual рендерят соответствующие бейджи', async () => {
    renderTable(() => [
      closedTradeFixture({ tradeRef: 'TR-5', closeReason: 'liquidation' }),
      closedTradeFixture({ tradeRef: 'TR-6', symbol: 'SOLUSDT', closeReason: 'manual' }),
    ])
    await screen.findByText('SOLUSDT')
    expect(screen.getByText('Liquidation')).toBeInTheDocument()
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })

  it('пустая история рендерит "No closed trades yet."', async () => {
    renderTable(() => [])
    expect(await screen.findByText('No closed trades yet.')).toBeInTheDocument()
  })

  it('«Load more» подгружает вторую страницу по курсору before=tradeRef', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      closedTradeFixture({ tradeRef: `TR-${i}`, symbol: `SYM${i}` }),
    )
    const page2 = [closedTradeFixture({ tradeRef: 'TR-LAST', symbol: 'LASTCOIN' })]
    renderTable((before) => (before ? page2 : page1))

    await screen.findByText('SYM0')
    expect(screen.queryByText('LASTCOIN')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    await screen.findByText('LASTCOIN')
    expect(screen.getByText('SYM0')).toBeInTheDocument()
  })
})
