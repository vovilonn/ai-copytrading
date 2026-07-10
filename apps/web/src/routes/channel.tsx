import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import type { ChannelDto } from 'shared/dto.js'
import { MessageTimeline } from '../components/MessageTimeline.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Switch } from '../components/ui/switch.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { apiFetch } from '../lib/api.js'
import { useState, type ReactNode } from 'react'

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
          <ChannelSettings channel={channel} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// Вкладка Settings (design/project/Admin.dc.html:251-302): в Ф0 все контролы задизейблены,
// значения берутся из ChannelDto. Default leverage/Allow cross margin в DTO ещё нет
// (появятся в Ф1 вместе с реальным сохранением) — разметка есть, но без данных под ней.
function ChannelSettings({ channel }: { channel: ChannelDto }) {
  return (
    <div className="max-w-[620px] rounded-[10px] border border-card-border bg-card px-5 py-1">
      <SettingsRow
        title="Copy trading"
        description="If off, messages are still parsed but every action is marked Skipped — no orders are sent to Bybit."
      >
        <Switch checked={channel.copyEnabled} disabled />
      </SettingsRow>

      <SettingsRow title="Trade size" description="Fixed notional used for every trade copied from this channel.">
        <div className="flex h-[34px] flex-none items-center overflow-hidden rounded-[7px] border border-white/[.12] bg-white/[.04]">
          <span className="pl-[11px] pr-[3px] text-[13px] text-muted-1">$</span>
          <Input
            type="number"
            value={stripCurrency(channel.tradeSize)}
            disabled
            readOnly
            className="h-full w-[88px] rounded-none border-none bg-transparent px-[4px] pr-[11px] text-[13px] disabled:opacity-100"
          />
        </div>
      </SettingsRow>

      <SettingsRow title="Max leverage" description="Signals above this leverage are clamped down to the limit.">
        <div className="flex h-[34px] flex-none items-center overflow-hidden rounded-[7px] border border-white/[.12] bg-white/[.04]">
          <Input
            type="number"
            value={stripLeverage(channel.maxLeverage)}
            disabled
            readOnly
            className="h-full w-[66px] rounded-none border-none bg-transparent pl-[11px] pr-[4px] text-[13px] disabled:opacity-100"
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
            type="number"
            placeholder="—"
            disabled
            className="h-full w-[66px] rounded-none border-none bg-transparent pl-[11px] pr-[4px] text-[13px]"
          />
          <span className="pl-[2px] pr-[11px] text-[13px] text-muted-1">x</span>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Allow cross margin"
        description="If off, positions from this channel are opened in isolated margin only."
        last
      >
        <Switch checked={false} disabled />
      </SettingsRow>

      <div className="flex items-center justify-end gap-3 border-t border-white/[.06] py-[18px] pb-2">
        <Button disabled size="sm" className="h-9 px-[18px] text-[13px]">
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
