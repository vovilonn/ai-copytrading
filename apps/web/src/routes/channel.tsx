import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { ChannelDto, ChannelSettingsDto } from 'shared/dto.js'
import { MessageTimeline } from '../components/MessageTimeline.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Switch } from '../components/ui/switch.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { apiFetch } from '../lib/api.js'
import { useChannelStatsStream } from '../lib/ws.js'

// Строки настроек в ChannelDto приходят уже отформатированными для таблицы каналов
// ('$500', '10x' — apps/api/src/channels/channels.service.ts, formatNumeric) — здесь их
// нужно распаковать обратно в голое число для инпутов (дизайн рисует символ $/x отдельным
// спаном рядом с полем, а не внутри значения).
function stripCurrency(value: string): string {
  return value.replace(/^\$/, '')
}
function stripLeverage(value: string): string {
  return value.replace(/x$/, '')
}

// Экран канала — шапка + табы Messages/Settings (design/project/Admin.dc.html:180-302).
// Хлебные крошки уже реализованы на уровне Layout (apps/web/src/routes/layout.tsx) —
// он сам запрашивает GET /channels/:id для заголовка крошки, здесь не дублируется.
export default function ChannelPage() {
  const { id } = useParams()
  const channelId = Number(id)
  const [tab, setTab] = useState<'messages' | 'settings'>('messages')

  const { data: channel } = useQuery({
    queryKey: ['channel', channelId],
    queryFn: () => apiFetch<ChannelDto>(`/channels/${channelId}`),
    enabled: Number.isFinite(channelId),
  })

  // Win Rate в реалтайме (задача Ф4) — до раннего return ниже (правило хуков: порядок вызовов
  // не должен зависеть от того, успел ли загрузиться channel).
  useChannelStatsStream(Number.isFinite(channelId) ? [channelId] : [])

  if (!channel) return null

  const isActive = channel.status === 'active'

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-center gap-[15px]">
        <div className="flex h-[50px] w-[50px] flex-none items-center justify-center rounded-[11px] bg-white/5 text-[19px] font-semibold text-secondary-1">
          {channel.initial}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 mb-1 text-[22px] font-semibold tracking-[-0.02em] text-fg">
            {channel.title}
          </h2>
          <p className="m-0 font-mono text-[13px] text-muted-2">
            {channel.handle} · {channel.messageCount} messages · {channel.actionCount} actions
          </p>
        </div>
        <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-secondary-1">
          <span
            className="h-[6px] w-[6px] flex-none rounded-full"
            style={{
              background: isActive ? '#34d399' : '#5a5a60',
              boxShadow: isActive ? '0 0 8px 0 rgba(52,211,153,.6)' : 'none',
            }}
          />
          {isActive ? 'Active' : 'Paused'}
        </span>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as 'messages' | 'settings')}
        className="flex flex-col gap-6"
      >
        <TabsList>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="messages">
          <MessageTimeline channelId={channelId} />
        </TabsContent>
        <TabsContent value="settings">
          {/* key={channel.id} — форма держит собственное несохранённое состояние, при переходе
              на другой канал (при том же смонтированном ChannelPage) её нужно проинициализировать
              заново из нового channel, а не донести правки чужого канала. */}
          <ChannelSettings key={channel.id} channel={channel} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface SettingsFormState {
  enabled: boolean
  tradeSize: string
  maxLeverage: string
  defaultLeverage: string // '' — не задано (плейсхолдер "—", null на бэке)
  crossMargin: boolean
  forceTradeSize: boolean
}

function toFormState(channel: ChannelDto): SettingsFormState {
  return {
    enabled: channel.copyEnabled,
    tradeSize: stripCurrency(channel.tradeSize),
    maxLeverage: stripLeverage(channel.maxLeverage),
    defaultLeverage: channel.defaultLeverage ? stripLeverage(channel.defaultLeverage) : '',
    crossMargin: channel.crossMargin,
    forceTradeSize: channel.forceTradeSize,
  }
}

interface SettingsPatchBody {
  enabled: boolean
  tradeSize: string
  maxLeverage: string
  defaultLeverage: string | null
  crossMargin: boolean
  forceTradeSize: boolean
}

// Тот же вид форматирования денег/плеча, что и бэкенд (apps/api/src/channels/channels.service.ts,
// formatNumeric) — нужен для оптимистичного апдейта кэша ДО ответа сервера (реальный ответ,
// ChannelSettingsDto, приходит уже в этом виде и просто перезаписывает оптимистичную догадку).
function normalizeNumber(raw: string): string {
  return String(Number(raw))
}

function applyOptimistic(channel: ChannelDto, body: SettingsPatchBody): ChannelDto {
  return {
    ...channel,
    copyEnabled: body.enabled,
    tradeSize: `$${normalizeNumber(body.tradeSize)}`,
    maxLeverage: `${normalizeNumber(body.maxLeverage)}x`,
    defaultLeverage: body.defaultLeverage !== null ? `${normalizeNumber(body.defaultLeverage)}x` : null,
    crossMargin: body.crossMargin,
    forceTradeSize: body.forceTradeSize,
  }
}

function mergeSettings(channel: ChannelDto, settings: ChannelSettingsDto): ChannelDto {
  return {
    ...channel,
    copyEnabled: settings.enabled,
    tradeSize: settings.tradeSize,
    maxLeverage: settings.maxLeverage,
    defaultLeverage: settings.defaultLeverage,
    crossMargin: settings.crossMargin,
    forceTradeSize: settings.forceTradeSize,
  }
}

// Дублирует правила валидации API (apps/api/src/channels/channel-settings.service.ts,
// assertValid) — на фронте это мгновенная обратная связь и экономия лишнего запроса,
// а не единственная линия обороны (сервер проверяет то же самое ещё раз).
function validateForm(form: SettingsFormState): string | null {
  const tradeSize = Number(form.tradeSize)
  if (!Number.isFinite(tradeSize) || tradeSize <= 0) return 'Trade size must be greater than 0'
  const maxLeverage = Number(form.maxLeverage)
  if (!Number.isFinite(maxLeverage) || maxLeverage < 1) return 'Max leverage must be at least 1'
  if (form.defaultLeverage.trim() !== '') {
    const defaultLeverage = Number(form.defaultLeverage)
    if (!Number.isFinite(defaultLeverage) || defaultLeverage < 1) {
      return 'Default leverage must be at least 1 (or left empty)'
    }
  }
  return null
}

const SAVED_FLASH_MS = 1800

// Вкладка Settings (design/project/Admin.dc.html:251-302): контролы активны — контролируемая
// форма (без react-hook-form/zod: react-hook-form отсутствует в apps/web/package.json, а форма
// всего из 5 полей без вложенной/динамической структуры — заводить новую зависимость ради неё
// избыточно, KISS). Save -> PATCH /channels/:id/settings, оптимистичный апдейт кэша
// ['channel', id]/['channels'], откат на ошибке (sonner), флеш "Saved" на ~1.8с.
// Экспортирован именованно (а не только используется внутри ChannelPage) — settings.test.tsx
// рендерит компонент напрямую, в обход Radix Tabs: клики по TabsTrigger в jsdom не переключают
// активную вкладку (Radix Tabs полагается на pointer capture, которого нет в jsdom), а сама форма
// не зависит от контекста Tabs — та же практика, что и с MessageTimeline (timeline.test.tsx).
export function ChannelSettings({ channel }: { channel: ChannelDto }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<SettingsFormState>(() => toFormState(channel))
  const [savedFlash, setSavedFlash] = useState(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    [],
  )

  const mutation = useMutation<
    ChannelSettingsDto,
    unknown,
    SettingsPatchBody,
    { prevChannel?: ChannelDto; prevChannels?: ChannelDto[] }
  >({
    mutationFn: (body) =>
      apiFetch<ChannelSettingsDto>(`/channels/${channel.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: ['channel', channel.id] })
      await queryClient.cancelQueries({ queryKey: ['channels'] })
      const prevChannel = queryClient.getQueryData<ChannelDto>(['channel', channel.id])
      const prevChannels = queryClient.getQueryData<ChannelDto[]>(['channels'])
      queryClient.setQueryData<ChannelDto>(['channel', channel.id], (old) =>
        old ? applyOptimistic(old, body) : old,
      )
      queryClient.setQueryData<ChannelDto[]>(['channels'], (old) =>
        old?.map((c) => (c.id === channel.id ? applyOptimistic(c, body) : c)),
      )
      return { prevChannel, prevChannels }
    },
    onError: (_err, _body, context) => {
      if (context?.prevChannel) queryClient.setQueryData(['channel', channel.id], context.prevChannel)
      if (context?.prevChannels) queryClient.setQueryData(['channels'], context.prevChannels)
      toast.error('Failed to save channel settings')
    },
    onSuccess: (settings) => {
      queryClient.setQueryData<ChannelDto>(['channel', channel.id], (old) =>
        old ? mergeSettings(old, settings) : old,
      )
      queryClient.setQueryData<ChannelDto[]>(['channels'], (old) =>
        old?.map((c) => (c.id === channel.id ? mergeSettings(c, settings) : c)),
      )
      setSavedFlash(true)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS)
    },
  })

  function handleSave() {
    const error = validateForm(form)
    if (error) {
      toast.error(error)
      return
    }
    mutation.mutate({
      enabled: form.enabled,
      tradeSize: form.tradeSize,
      maxLeverage: form.maxLeverage,
      defaultLeverage: form.defaultLeverage.trim() === '' ? null : form.defaultLeverage,
      crossMargin: form.crossMargin,
      forceTradeSize: form.forceTradeSize,
    })
  }

  return (
    <div className="max-w-[620px] rounded-[10px] border border-card-border bg-card px-5 py-1">
      <SettingsRow
        title="Copy trading"
        description="If off, messages are not parsed at all — no AI calls, no actions, no orders. Open positions of this channel keep running: close them before turning it off."
      >
        <Switch
          aria-label="Copy trading"
          checked={form.enabled}
          onCheckedChange={(checked) => setForm((f) => ({ ...f, enabled: checked }))}
        />
      </SettingsRow>

      <SettingsRow
        title="Trade size"
        description="Margin per trade — the amount actually taken from your balance. Position size = this × leverage. Used when the signal names no risk %."
      >
        <div className="flex h-[34px] flex-none items-center overflow-hidden rounded-[7px] border border-white/[.12] bg-white/[.04]">
          <span className="pl-[11px] pr-[3px] text-[13px] text-muted-1">$</span>
          <Input
            aria-label="Trade size"
            type="number"
            value={form.tradeSize}
            onChange={(e) => setForm((f) => ({ ...f, tradeSize: e.target.value }))}
            className="h-full w-[88px] rounded-none border-none bg-transparent px-[4px] pr-[11px] text-[13px]"
          />
        </div>
      </SettingsRow>

      <SettingsRow title="Max leverage" description="Signals above this leverage are clamped down to the limit.">
        <div className="flex h-[34px] flex-none items-center overflow-hidden rounded-[7px] border border-white/[.12] bg-white/[.04]">
          <Input
            aria-label="Max leverage"
            type="number"
            value={form.maxLeverage}
            onChange={(e) => setForm((f) => ({ ...f, maxLeverage: e.target.value }))}
            className="h-full w-[66px] rounded-none border-none bg-transparent pl-[11px] pr-[4px] text-[13px]"
          />
          <span className="pl-[2px] pr-[11px] text-[13px] text-muted-1">x</span>
        </div>
      </SettingsRow>

      <SettingsRow
        title={
          <>
            Default leverage <span className="font-medium text-muted-2">· optional</span>
          </>
        }
        description="Used when a signal doesn't specify leverage. Leave empty to skip."
      >
        <div className="flex h-[34px] flex-none items-center overflow-hidden rounded-[7px] border border-white/[.12] bg-white/[.04]">
          <Input
            aria-label="Default leverage"
            type="number"
            placeholder="—"
            value={form.defaultLeverage}
            onChange={(e) => setForm((f) => ({ ...f, defaultLeverage: e.target.value }))}
            className="h-full w-[66px] rounded-none border-none bg-transparent pl-[11px] pr-[4px] text-[13px]"
          />
          <span className="pl-[2px] pr-[11px] text-[13px] text-muted-1">x</span>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Always use trade size"
        description="If on, this fixed amount is used for every trade — even when the signal names a risk %. If off, a signal with «Риск: 1%» sizes the position from that risk and the stop distance instead."
      >
        <Switch
          aria-label="Always use trade size"
          checked={form.forceTradeSize}
          onCheckedChange={(checked) => setForm((f) => ({ ...f, forceTradeSize: checked }))}
        />
      </SettingsRow>

      <SettingsRow
        title="Allow cross margin"
        description="If off, positions from this channel are opened in isolated margin only."
        last
      >
        <Switch
          aria-label="Allow cross margin"
          checked={form.crossMargin}
          onCheckedChange={(checked) => setForm((f) => ({ ...f, crossMargin: checked }))}
        />
      </SettingsRow>

      <div className="flex items-center justify-end gap-3 border-t border-white/[.06] py-[18px] pb-2">
        {savedFlash && (
          <span
            className="inline-flex items-center gap-[5px] text-[12.5px] font-semibold"
            style={{ color: '#34d399' }}
          >
            <CircleCheck size={14} color="#34d399" className="inline-flex flex-none" />
            Saved
          </span>
        )}
        <Button size="sm" className="h-9 px-[18px] text-[13px]" onClick={handleSave} disabled={mutation.isPending}>
          Save changes
        </Button>
      </div>
    </div>
  )
}

function SettingsRow({
  title,
  description,
  children,
  last = false,
}: {
  title: ReactNode
  description: string
  children: ReactNode
  last?: boolean
}) {
  return (
    <div
      className={`flex items-start justify-between gap-6 py-[18px] ${last ? '' : 'border-b border-white/[.06]'}`}
    >
      <div className="min-w-0">
        <div className="mb-[3px] text-[13.5px] font-semibold text-fg">{title}</div>
        <div className="max-w-[380px] text-[12.5px] leading-[1.5] text-muted-1">{description}</div>
      </div>
      {children}
    </div>
  )
}
