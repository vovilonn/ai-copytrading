import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { AccountWalletDto, ChannelPnlDto } from 'shared/dto.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelPnlTable, WalletCard } from '../src/components/AccountPanels.js'
import { apiFetch } from '../src/lib/api.js'

vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))

function walletFixture(overrides: Partial<AccountWalletDto> = {}): AccountWalletDto {
  return {
    totalEquity: '$10,000.00',
    availableBalance: '$8,500.00',
    currency: 'USDT',
    asOf: '2026-07-12T10:00:00.000Z',
    perChannel: [],
    ...overrides,
  }
}

function renderWallet(wallet: AccountWalletDto) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/account/wallet') return wallet
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <WalletCard />
    </QueryClientProvider>,
  )
}

function renderChannelPnl(rows: ChannelPnlDto[]) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/positions/stats/by-channel') return rows
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChannelPnlTable />
    </QueryClientProvider>,
  )
}

describe('WalletCard', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('рендерит баланс аккаунта из DTO', async () => {
    renderWallet(walletFixture())
    const equity = await screen.findByTestId('wallet-equity')
    expect(equity).toHaveTextContent('$10,000.00')
    expect(screen.getByText('$8,500.00')).toBeInTheDocument()
    expect(screen.getByText('USDT')).toBeInTheDocument()
    expect(screen.queryByTestId('wallet-empty')).not.toBeInTheDocument()
  })

  it('asOf=null рендерит плейсхолдер «нет данных о балансе», а не нулевой баланс', async () => {
    renderWallet(walletFixture({ asOf: null, totalEquity: '$0.00', availableBalance: '$0.00' }))
    expect(await screen.findByTestId('wallet-empty')).toHaveTextContent('No balance data yet')
    expect(screen.queryByTestId('wallet-equity')).not.toBeInTheDocument()
  })

  it('totalEquity=$0.00 при заполненном asOf всё равно даёт плейсхолдер', async () => {
    renderWallet(walletFixture({ totalEquity: '$0.00' }))
    expect(await screen.findByTestId('wallet-empty')).toBeInTheDocument()
  })
})

describe('ChannelPnlTable', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('рендерит строку PnL по каналу с цветом по знаку', async () => {
    renderChannelPnl([
      {
        channelId: 1,
        channelTitle: 'Crypto Signals VIP',
        openPositions: 2,
        unrealisedPnl: '+$327.60',
        realizedPnl: '-$50.00',
        totalPnl: '+$277.60',
        winRate: '68%',
      },
    ])
    await screen.findByText('Crypto Signals VIP')

    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('+$327.60')).toHaveClass('text-long')
    expect(screen.getByText('-$50.00')).toHaveClass('text-short')
    expect(screen.getByText('+$277.60')).toHaveClass('text-long')
    expect(screen.getByText('68%')).toBeInTheDocument()
  })

  it('пустой ответ рендерит "No PnL recorded for any channel yet."', async () => {
    renderChannelPnl([])
    expect(await screen.findByText('No PnL recorded for any channel yet.')).toBeInTheDocument()
  })
})
