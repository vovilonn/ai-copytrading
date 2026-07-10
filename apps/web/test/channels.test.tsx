import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ChannelDto } from 'shared/dto.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChannelPage from '../src/routes/channel.js'
import ChannelsPage from '../src/routes/channels.js'
import { apiFetch } from '../src/lib/api.js'

// apiFetch замокан целиком — тест проверяет только рендер таблицы и навигацию,
// без реальной сети (GET /channels).
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))
// ChannelPage (после задачи 12) тянет реалтайм через useChannelStream/socket.io-client —
// в этом файле проверяется только навигация со списка каналов, поэтому сокет замокан в no-op,
// чтобы не открывать реальное соединение внутри jsdom.
vi.mock('../src/lib/ws.js', () => ({ useChannelStream: () => {} }))

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
    actionCount: 12,
    activePositions: 2,
    messageCount: 340,
    tradeSize: '$500',
    maxLeverage: '10x',
  },
  {
    id: 2,
    key: 'ch-2',
    title: 'Meme Coin Calls',
    handle: '@memecalls',
    initial: 'M',
    status: 'paused',
    copyEnabled: false,
    winRate: '44%',
    actionCount: 3,
    activePositions: 0,
    messageCount: 90,
    tradeSize: '$100',
    maxLeverage: '3x',
  },
]

const HEADERS = [
  'Channel',
  'Copy',
  'Win Rate',
  'Actions',
  'Active Positions',
  'Messages',
  'Trade size',
  'Max lev',
]

function renderChannels() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/channels']}>
        <Routes>
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/channels/:id" element={<ChannelPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// ChannelPage запрашивает GET /channels/:id (шапка) и GET /channels/:id/messages (таймлайн) —
// апиfetch тут мокается по пути запроса, а не одним and тем же значением для всех вызовов.
function mockApiByPath() {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/channels') return CHANNELS
    const messagesMatch = /^\/channels\/(\d+)\/messages/.exec(path)
    if (messagesMatch) return []
    const channelMatch = /^\/channels\/(\d+)$/.exec(path)
    if (channelMatch) {
      const found = CHANNELS.find((c) => String(c.id) === channelMatch[1])
      if (found) return found
    }
    throw new Error(`неожиданный путь в моке apiFetch: ${path}`)
  })
}

describe('ChannelsPage', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    mockApiByPath()
  })

  it('рендерит все восемь заголовков колонок', async () => {
    renderChannels()
    await screen.findByText('Crypto Signals VIP')
    for (const header of HEADERS) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
  })

  it('бейдж Copy зелёный при copyEnabled: true, серый при false', async () => {
    renderChannels()
    await screen.findByText('Crypto Signals VIP')
    const on = screen.getByText('On')
    const off = screen.getByText('Off')
    expect(on).toHaveClass('text-long')
    expect(off).not.toHaveClass('text-long')
  })

  it('клик по строке ведёт на /channels/:id', async () => {
    renderChannels()
    const row = await screen.findByText('Crypto Signals VIP')
    row.closest('tr')?.click()
    // Список каналов размонтируется при переходе — на экране канала остаётся его шапка
    // (design/project/Admin.dc.html:184: `{handle} · {messageCount} messages · {actionCount} actions`).
    expect(await screen.findByText('@crypto_vip · 340 messages · 12 actions')).toBeInTheDocument()
  })
})
