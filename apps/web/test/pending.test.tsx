import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import type { PendingOrderDto } from 'shared/dto.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTtl, PendingOrders } from '../src/components/PendingOrders.js'
import { apiFetch } from '../src/lib/api.js'

// apiFetch замокан целиком — тот же приём, что и positions.test.tsx: тест проверяет только
// рендер/пустое состояние/обратный отсчёт, без реальной сети.
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))

function fixture(overrides: Partial<PendingOrderDto> = {}): PendingOrderDto {
  return {
    id: 'order-1',
    symbol: 'BTCUSDT',
    side: 'long',
    purpose: 'entry',
    price: '60000',
    qty: '0.5',
    channelId: 1,
    channelTitle: 'Crypto Signals VIP',
    tradeRef: '#TR-1042',
    orderLinkId: 'link-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    submittedAt: '2026-01-01T00:00:01.000Z',
    ttlExpiresAt: '2026-01-08T00:00:00.000Z',
    ...overrides,
  }
}

function renderPending(orders: PendingOrderDto[]) {
  vi.mocked(apiFetch).mockResolvedValue(orders)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <PendingOrders />
    </QueryClientProvider>,
  )
}

describe('formatTtl', () => {
  it('минуты/секунды — "4m 12s"', () => {
    expect(formatTtl(4 * 60_000 + 12_000)).toBe('4m 12s')
  })

  it('часы/минуты — "3h 8m" (дни/часы укрупняются, не показывая бесполезные секунды)', () => {
    expect(formatTtl(3 * 3_600_000 + 8 * 60_000)).toBe('3h 8m')
  })

  it('дни/часы — "2d 5h" (дефолт limit_ttl_sec=604800с даёт именно этот масштаб)', () => {
    expect(formatTtl(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h')
  })

  it('истёкший/отрицательный остаток — "expired"', () => {
    expect(formatTtl(0)).toBe('expired')
    expect(formatTtl(-1)).toBe('expired')
  })
})

describe('PendingOrders', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('рендерит строку из DTO — Symbol/Side/Purpose/Price/Qty/Channel/tradeRef', async () => {
    renderPending([fixture()])
    await screen.findByText('BTCUSDT')

    expect(screen.getByText('LONG')).toBeInTheDocument()
    expect(screen.getByText('Entry')).toBeInTheDocument()
    expect(screen.getByText('60000')).toBeInTheDocument()
    expect(screen.getByText('0.5')).toBeInTheDocument()
    expect(screen.getByText('Crypto Signals VIP')).toBeInTheDocument()
    expect(screen.getByText('#TR-1042')).toBeInTheDocument()
  })

  it('short-ордер рендерит SHORT и purpose "Add"', async () => {
    renderPending([fixture({ side: 'short', purpose: 'add', symbol: 'ETHUSDT', tradeRef: null })])
    await screen.findByText('ETHUSDT')

    expect(screen.getByText('SHORT')).toBeInTheDocument()
    expect(screen.getByText('Add')).toBeInTheDocument()
  })

  it('пустой список рендерит "No pending limit orders."', async () => {
    renderPending([])
    expect(await screen.findByText('No pending limit orders.')).toBeInTheDocument()
    expect(screen.queryByText('BTCUSDT')).not.toBeInTheDocument()
  })

  it('упавший запрос рендерит сообщение об ошибке, а не пустое состояние', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <PendingOrders />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Failed to load pending orders. Please try again.')).toBeInTheDocument()
    expect(screen.queryByText('No pending limit orders.')).not.toBeInTheDocument()
  })

  it('обратный отсчёт TTL тикает раз в секунду (useEffect + setInterval) и доходит до "expired"', async () => {
    vi.useFakeTimers()

    // Date заморожен вместе с остальными таймерами (fake timers по умолчанию подменяют и его) —
    // Date.now() внутри useNowTick при монтировании и Date.now() здесь читают ОДНО и то же
    // "замороженное" мгновение, поэтому остаток до TTL детерминирован день в день.
    const expiresAt = new Date(Date.now() + 2500).toISOString()
    vi.mocked(apiFetch).mockResolvedValue([fixture({ ttlExpiresAt: expiresAt })])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <PendingOrders />
      </QueryClientProvider>,
    )

    // Флашим микротаск разрешения замоканного apiFetch (react-query), не продвигая часы.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('0m 2s')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(screen.getByText('0m 1s')).toBeInTheDocument()
    expect(screen.queryByText('0m 2s')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByText('expired')).toBeInTheDocument()
  })
})
