import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChannelDto, ChannelSettingsDto } from 'shared/dto.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettings } from '../src/routes/channel.js'
import { apiFetch } from '../src/lib/api.js'
import { toast } from 'sonner'

// apiFetch замокан целиком — тест проверяет только поведение формы (PATCH-запрос, Saved-флеш,
// валидацию, откат кэша), без реальной сети. ChannelSettings рендерится напрямую (не через
// ChannelPage/Radix Tabs) — клик по TabsTrigger не переключает активную вкладку в jsdom (Radix
// Tabs полагается на pointer capture, которого там нет), а сама форма от Tabs не зависит.
vi.mock('../src/lib/api.js', () => ({ apiFetch: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const CHANNEL: ChannelDto = {
  id: 1,
  key: 'ch-1',
  title: 'Crypto Signals VIP',
  handle: '@crypto_vip',
  initial: 'C',
  status: 'active',
  copyEnabled: false,
  winRate: '68%',
  actionCount: 12,
  activePositions: 2,
  messageCount: 340,
  tradeSize: '$500',
  maxLeverage: '10x',
  defaultLeverage: null,
  crossMargin: true,
}

function renderSettings(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={queryClient}>
      <ChannelSettings channel={CHANNEL} />
    </QueryClientProvider>,
  )
  return queryClient
}

function findPatchCall() {
  return vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PATCH')
}

describe('ChannelSettings (Settings-таб канала)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  it('контролы активны (не disabled) и отражают текущие значения канала', () => {
    renderSettings()

    const copyToggle = screen.getByRole('switch', { name: 'Copy trading' })
    const crossToggle = screen.getByRole('switch', { name: 'Allow cross margin' })
    const tradeSize = screen.getByRole('spinbutton', { name: 'Trade size' })
    const maxLeverage = screen.getByRole('spinbutton', { name: 'Max leverage' })
    const defaultLeverage = screen.getByRole('spinbutton', { name: 'Default leverage' })
    const saveButton = screen.getByRole('button', { name: 'Save changes' })

    expect(copyToggle).not.toBeDisabled()
    expect(crossToggle).not.toBeDisabled()
    expect(tradeSize).not.toBeDisabled()
    expect(maxLeverage).not.toBeDisabled()
    expect(defaultLeverage).not.toBeDisabled()
    expect(saveButton).not.toBeDisabled()

    expect(copyToggle).toHaveAttribute('aria-checked', 'false')
    expect(crossToggle).toHaveAttribute('aria-checked', 'true')
    expect(tradeSize).toHaveValue(500)
    expect(maxLeverage).toHaveValue(10)
    expect(defaultLeverage).toHaveValue(null)
    expect(defaultLeverage).toHaveAttribute('placeholder', '—')
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('Save включает Copy trading, меняет Trade size на 300, шлёт PATCH с изменёнными полями и показывает "Saved"', async () => {
    const settingsResponse: ChannelSettingsDto = {
      channelId: 1,
      enabled: true,
      tradeSize: '$300',
      maxLeverage: '10x',
      defaultLeverage: null,
      crossMargin: true,
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(settingsResponse)

    renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: 'Copy trading' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trade size' }), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(findPatchCall()).toBeDefined())
    const [path, init] = findPatchCall()!
    expect(path).toBe('/channels/1/settings')
    expect(JSON.parse(init!.body as string)).toEqual({
      enabled: true,
      tradeSize: '300',
      maxLeverage: '10',
      defaultLeverage: null,
      crossMargin: true,
    })

    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('после успешного Save кэш ["channel", id] и ["channels"] обновлён ответом сервера', async () => {
    const settingsResponse: ChannelSettingsDto = {
      channelId: 1,
      enabled: true,
      tradeSize: '$300',
      maxLeverage: '10x',
      defaultLeverage: null,
      crossMargin: true,
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(settingsResponse)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['channel', 1], CHANNEL)
    queryClient.setQueryData(['channels'], [CHANNEL])
    renderSettings(queryClient)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trade size' }), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await screen.findByText('Saved')
    expect(queryClient.getQueryData<ChannelDto>(['channel', 1])?.tradeSize).toBe('$300')
    expect(queryClient.getQueryData<ChannelDto>(['channel', 1])?.copyEnabled).toBe(true)
    expect(queryClient.getQueryData<ChannelDto[]>(['channels'])?.[0]?.tradeSize).toBe('$300')
  })

  it('невалидный Trade size (0) — ошибка, PATCH не отправляется', async () => {
    renderSettings()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trade size' }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Trade size must be greater than 0')
    })
    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('невалидный Max leverage (0) — ошибка, PATCH не отправляется', async () => {
    renderSettings()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max leverage' }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Max leverage must be at least 1')
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('невалидный Default leverage (0, непустой) — ошибка, PATCH не отправляется', async () => {
    renderSettings()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Default leverage' }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Default leverage must be at least 1 (or left empty)')
    })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('ошибка PATCH откатывает оптимистичный апдейт кэша и показывает toast, без "Saved"', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('500'))

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['channel', 1], CHANNEL)
    renderSettings(queryClient)

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Trade size' }), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save channel settings')
    })
    expect(screen.queryByText('Saved')).toBeNull()
    // Кэш откатился к исходному значению ($500), а не остался с оптимистичной догадкой ($300).
    expect(queryClient.getQueryData<ChannelDto>(['channel', 1])?.tradeSize).toBe('$500')
  })
})
