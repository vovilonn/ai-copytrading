import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query'
import { Image as ImageIcon, Layers, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { MessageDto } from 'shared/dto.js'
import { apiFetch } from '../lib/api.js'
import { useChannelStream } from '../lib/ws.js'

const PAGE_SIZE = 50

// Общий ключ инвалидации/патча кэша — используется и здесь (useInfiniteQuery), и в
// lib/ws.ts (useChannelStream вставляет message.new в этот же кэш), поэтому вынесен
// в один экспорт вместо дублирования литерала массива в двух файлах.
export function messagesQueryKey(channelId: number): QueryKey {
  return ['channel', channelId, 'messages']
}

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso))
}

async function fetchMessages(channelId: number, before?: number): Promise<MessageDto[]> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) params.set('before', String(before))
  return apiFetch<MessageDto[]>(`/channels/${channelId}/messages?${params.toString()}`)
}

interface MessageTimelineProps {
  channelId: number
}

// Таймлайн сообщений канала — геометрия 1 к 1 из design/project/Admin.dc.html:194-249
// (вертикальная линия left:15px, плитка узла 32x32, текст с white-space:pre-line и т.д.).
// Данные — useInfiniteQuery по курсору before=<tgMessageId>, первая страница 50 сообщений
// (бриф задачи 12). Реалтайм — useChannelStream (lib/ws.ts) вставляет message.new в тот же кэш.
export function MessageTimeline({ channelId }: MessageTimelineProps) {
  useChannelStream(channelId)

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: messagesQueryKey(channelId),
    queryFn: ({ pageParam }: { pageParam: number | undefined }) => fetchMessages(channelId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[lastPage.length - 1]?.tgMessageId,
  })

  const messages = data?.pages.flat() ?? []

  return (
    <div className="relative max-w-[720px]">
      <div className="absolute bottom-[26px] left-[15px] top-[22px] w-px bg-white/[.08]" />
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} />
      ))}
      {/* Загрузка по кнопке, а не по скроллу: детерминированное поведение без
          IntersectionObserver (не тривиально мокается в jsdom-тестах) — обоснование в отчёте. */}
      {hasNextPage ? (
        <div className="relative flex justify-center pb-[26px] pl-[50px]">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="cursor-pointer rounded-md border border-white/10 bg-transparent px-4 py-2 font-sans text-[12.5px] font-medium text-secondary-2 hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MessageRow({ message }: { message: MessageDto }) {
  const hasActions = message.actions.length > 0

  return (
    <div className="relative flex gap-[18px] pb-[26px]" data-testid="message-row">
      <NodeTile hasActions={hasActions} />
      <div className="min-w-0 flex-1 pt-[5px]">
        <div className="mb-2 flex items-center gap-[9px]">
          <span className="font-mono text-[11.5px] text-muted-2">{formatTime(message.time)}</span>
        </div>

        <div className="whitespace-pre-line text-sm leading-[1.6] text-message">{message.text}</div>

        {message.media.map((media) => (
          <MediaTile key={media.url} media={media} />
        ))}

        {/* Блок actions (1..N строк) появится в Ф1 — в Ф0 message.actions всегда [], поэтому
            рендерится только AI-саммари для сообщений без действий (design:234-243). */}
        {!hasActions && message.aiSummary ? <AiSummary text={message.aiSummary} /> : null}
      </div>
    </div>
  )
}

function NodeTile({ hasActions }: { hasActions: boolean }) {
  if (!hasActions) {
    return (
      <div
        className="relative z-[1] flex h-8 w-8 flex-none items-center justify-center bg-black"
        data-testid="node-tile"
      >
        <span
          className="block h-[7px] w-[7px] rounded-full"
          style={{ background: '#3a3a40' }}
          data-testid="node-dot"
        />
      </div>
    )
  }

  // Плитка узла с иконкой действия — заготовка на Ф1 (design/project/Admin.dc.html:200-203).
  // В Ф0 message.actions всегда пуст, эта ветка вживую не достижима.
  return (
    <div
      className="relative z-[1] flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-white/[.12] bg-[#161618]"
      data-testid="node-tile"
    >
      <Layers size={16} color="#e5e5e5" />
    </div>
  )
}

function MediaTile({ media }: { media: MessageDto['media'][number] }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className="mt-3 flex h-[176px] w-full max-w-[340px] items-center justify-center gap-[9px] overflow-hidden rounded-lg"
        style={{
          border: '1px dashed rgba(255,255,255,.1)',
          background:
            'repeating-linear-gradient(135deg,rgba(255,255,255,.02),rgba(255,255,255,.02) 8px,transparent 8px,transparent 16px)',
        }}
      >
        <ImageIcon size={19} color="#5a5a60" />
        <span className="font-mono text-[11.5px] text-muted-2">
          {media.kind === 'video-thumb' ? 'video preview unavailable' : 'photo unavailable'}
        </span>
      </div>
    )
  }

  return (
    <div
      className="mt-3 h-[176px] w-full max-w-[340px] overflow-hidden rounded-lg"
      style={{ border: '1px solid rgba(255,255,255,.09)', background: '#0a0a0c' }}
    >
      <img
        src={media.url}
        alt=""
        className="block h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function AiSummary({ text }: { text: string }) {
  return (
    <div className="mt-[11px] flex items-start gap-2" data-testid="ai-summary">
      <span className="flex h-[19px] flex-none items-center">
        <Sparkles size={13} color="#ff8a4d" />
      </span>
      <span className="text-[12.5px] font-light leading-[1.55] text-muted-1">{text}</span>
    </div>
  )
}
