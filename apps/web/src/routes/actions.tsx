import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ActionRowDto, ChannelDto } from 'shared/dto.js'
import { LoadMore } from '../components/LoadMore.js'
import { SegmentedControl, type SegmentOption } from '../components/SegmentedControl.js'
import { TableStateRow } from '../components/TableStateRow.js'
import { Card } from '../components/ui/card.js'
import { Input } from '../components/ui/input.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js'
import { skipReasonLabel } from 'shared/skip-reason.js'
import { getActionIcon, isNeedsReviewReason, normalizeTradeRef } from '../lib/action-display.js'
import { apiFetch } from '../lib/api.js'
import { type Cursor, useCursorList } from '../lib/use-cursor-list.js'
import { cn } from '../lib/utils.js'
import { useActionsStream } from '../lib/ws.js'

// Task 4 (мониторинг): keyset-пагинация «load more» — первая страница PAGE_SIZE строк, курсор
// before=<последний action.id> (GET /api/actions уже курсорный, actions.service.ts). Бэкенд
// сам clamp'ит limit (DEFAULT_LIMIT/MAX_LIMIT), фронт передаёт PAGE_SIZE явно.
const PAGE_SIZE = 50

// Ровно списки сегментов из design/project/Admin.dc.html:708-710 (periodOpts/typeOpts/dirOpts) —
// Type сознательно НЕ покрывает все 12 ActionType (шире, чем 4 варианта дизайна): бэкенд отдаёт
// готовую строку/иконку для остальных 8 (tp_hit, modify_sl, ...), см. shared/action-meta.ts,
// они просто не фильтруются отдельной кнопкой, но видны под "All".
const PERIOD_OPTIONS: SegmentOption[] = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
]
const TYPE_OPTIONS: SegmentOption[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'close', label: 'Close' },
  { value: 'partial_tp', label: 'Partial TP' },
  { value: 'partial_close', label: 'Partial close' },
]
const SIDE_OPTIONS: SegmentOption[] = [
  { value: 'all', label: 'All' },
  { value: 'long', label: 'LONG' },
  { value: 'short', label: 'SHORT' },
]

const timeFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso))
}

interface ActionsFilters {
  channel: string
  period: string
  type: string
  side: string
  q: string
}

async function fetchActions(filters: ActionsFilters, before: Cursor | undefined): Promise<ActionRowDto[]> {
  const params = new URLSearchParams()
  if (filters.channel !== 'all') params.set('channel', filters.channel)
  if (filters.period !== 'all') params.set('period', filters.period)
  if (filters.type !== 'all') params.set('type', filters.type)
  if (filters.side !== 'all') params.set('side', filters.side)
  if (filters.q.trim()) params.set('q', filters.q.trim())
  params.set('limit', String(PAGE_SIZE))
  if (before !== undefined) params.set('before', String(before))
  return apiFetch<ActionRowDto[]>(`/actions?${params.toString()}`)
}

// Страница Actions (design/project/Admin.dc.html:306-392) — плоский список действий across всех
// каналов, фильтры отражены в URL (useSearchParams), как и на остальных страницах фазы 1.
export default function ActionsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const channel = searchParams.get('channel') ?? 'all'
  const period = searchParams.get('period') ?? 'all'
  const type = searchParams.get('type') ?? 'all'
  const side = searchParams.get('side') ?? 'all'
  const q = searchParams.get('q') ?? ''

  function setFilter(key: string, value: string): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!value || value === 'all') next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  }

  // Поиск по паре — лёгкий дебаунс 300мс перед тем, как попасть в URL/запрос: без него каждое
  // нажатие клавиши гоняло бы отдельный GET /api/actions. pendingQuery ресинкается с q, если URL
  // поменялся снаружи (навигация назад/вперёд), чтобы не перезаписать его устаревшим таймером.
  const [pendingQuery, setPendingQuery] = useState(q)
  useEffect(() => setPendingQuery(q), [q])
  useEffect(() => {
    if (pendingQuery === q) return
    const timer = setTimeout(() => setFilter('q', pendingQuery), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery])

  // Тот же queryKey/queryFn, что и на странице Channels — TanStack Query переиспользует кэш
  // между страницами вместо повторного запроса. Тот же список используется и для join'а с
  // realtime (useActionsStream подписывается на комнату КАЖДОГО канала — общей комнаты
  // "все каналы" у шлюза нет, см. lib/ws.ts).
  const { data: channelsData } = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiFetch<ChannelDto[]>('/channels'),
  })
  const channels = channelsData ?? []
  useActionsStream(channels.map((c) => c.id))

  const filters: ActionsFilters = { channel, period, type, side, q }
  const {
    items: actions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    isError,
  } = useCursorList<ActionRowDto>({
    queryKey: ['actions', filters],
    fetchPage: (before) => fetchActions(filters, before),
    getCursor: (a) => a.id,
    pageSize: PAGE_SIZE,
  })

  const channelOptions: SegmentOption[] = [
    { value: 'all', label: 'All channels' },
    ...channels.map((c) => ({ value: String(c.id), label: c.title })),
  ]

  return (
    <div className="flex w-full flex-col gap-[22px]">
      <div>
        <h2 className="m-0 mb-[5px] text-[22px] font-semibold tracking-[-0.02em] text-fg">Actions</h2>
        <p className="m-0 text-[13.5px] text-muted-1">Every trade action extracted across all channels</p>
      </div>

      <div className="flex w-full flex-col gap-[13px]" data-m="filters">
        <SegmentedControl
          label="Channel"
          wrap
          options={channelOptions}
          value={channel}
          onChange={(v) => setFilter('channel', v)}
        />
        <div className="flex flex-wrap items-center gap-[18px]">
          <SegmentedControl
            label="Period"
            options={PERIOD_OPTIONS}
            value={period}
            onChange={(v) => setFilter('period', v)}
          />
          <SegmentedControl label="Type" options={TYPE_OPTIONS} value={type} onChange={(v) => setFilter('type', v)} />
          <SegmentedControl label="Side" options={SIDE_OPTIONS} value={side} onChange={(v) => setFilter('side', v)} />
          <div className="relative ml-auto flex items-center" data-m="searchwrap">
            <Search size={15} className="pointer-events-none absolute left-[11px] text-muted-2" />
            <Input
              value={pendingQuery}
              onChange={(e) => setPendingQuery(e.target.value)}
              placeholder="Search by pair…"
              className="h-[34px] w-[230px] rounded-[7px] pl-[33px] pr-3 text-[12.5px]"
            />
          </div>
        </div>
      </div>

      <Card data-m="tablecard" className="w-full overflow-hidden">
        <Table style={{ minWidth: '860px' }}>
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead className="px-[22px]">Action</TableHead>
              <TableHead>Pair</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Trade</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="px-[22px]">Method</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actions.map((action) => (
              <ActionTableRow
                key={action.id}
                action={action}
                onChannelClick={() => navigate(`/channels/${action.channelId}`)}
                onTradeClick={(ref) => navigate(`/positions?tr=${encodeURIComponent(ref)}`)}
              />
            ))}
          </TableBody>
        </Table>
        <TableStateRow
          isPending={isPending}
          isError={isError}
          isEmpty={actions.length === 0}
          emptyMessage="No actions match the selected filters."
          errorMessage="Failed to load actions. Please try again."
        />
      </Card>
      <LoadMore
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
      />
    </div>
  )
}

interface ActionTableRowProps {
  action: ActionRowDto
  onChannelClick: () => void
  onTradeClick: (ref: string) => void
}

function ActionTableRow({ action, onChannelClick, onTradeClick }: ActionTableRowProps) {
  const isAiMethod = action.method === 'ai'
  // Бриф: "для open ещё LONG/SHORT цветом" — бейдж стороны рисуется ТОЛЬКО у open (design:
  // dirTextStyle рядом с shortStyle), остальные типы (close/partial_tp/tp_hit/...) его не несут,
  // хотя иконка/цвет иконки у них тоже приходят из action-meta.ts (iconColor).
  const showDir = action.type === 'open' && action.side !== null
  const Icon = getActionIcon(action.icon)

  return (
    <TableRow className="hover:bg-white/[.02]">
      <TableCell className="px-[22px]">
        <span className="inline-flex items-center gap-[10px]">
          <span className="inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-white/5">
            <Icon size={15} color={action.iconColor} className="flex-none" />
          </span>
          <span className="text-[12.5px] font-semibold tracking-[.02em]" style={{ color: action.iconColor }}>
            {action.short}
          </span>
          {showDir ? (
            <span
              className={cn(
                'text-[12.5px] font-semibold tracking-[.02em]',
                action.side === 'long' ? 'text-long' : 'text-short',
              )}
            >
              {action.side === 'long' ? 'LONG' : 'SHORT'}
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="font-mono text-[13px] font-semibold text-fg">{action.pair ?? '—'}</TableCell>
      <TableCell className="max-w-[300px] text-[12.5px] text-secondary-2">{action.summary}</TableCell>
      <TableCell>
        {action.skipReason ? (
          <span className="inline-flex flex-wrap items-center gap-[6px]">
            <span
              title={action.skipReason}
              className="inline-flex items-center rounded-[5px] bg-skipped-bg px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[.04em] text-skipped"
            >
              {isNeedsReviewReason(action.skipReason) ? 'Needs review' : 'Skipped'}
            </span>
            {/* Причина видна сразу, а не только в подсказке при наведении. */}
            <span className="text-[11.5px] leading-none text-muted-2">{skipReasonLabel(action.skipReason)}</span>
          </span>
        ) : action.tradeRef ? (
          <button
            type="button"
            onClick={() => onTradeClick(action.tradeRef!)}
            className="inline-flex cursor-pointer items-center gap-[5px] rounded-md border-none bg-white/5 px-[9px] py-1 font-mono text-xs font-semibold text-[#d4d4d8] transition-colors hover:bg-[rgba(255,106,31,.12)] hover:text-accent-hover"
          >
            {`Trade ${normalizeTradeRef(action.tradeRef)}`}
          </button>
        ) : null}
      </TableCell>
      <TableCell>
        <span
          data-testid="channel-link"
          onClick={onChannelClick}
          className="inline-flex cursor-pointer items-center gap-[9px] hover:opacity-[.72]"
        >
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-white/5 text-[11px] font-semibold text-secondary-2">
            {action.channelInitial}
          </span>
          <span className="whitespace-nowrap text-[12.5px] text-secondary-1">{action.channelName}</span>
        </span>
      </TableCell>
      <TableCell className="font-mono text-[12.5px] text-muted-2">{formatTime(action.time)}</TableCell>
      <TableCell className="px-[22px]">
        <span
          className={cn('text-xs', isAiMethod ? 'font-semibold text-accent-hover' : 'font-medium text-secondary-3')}
        >
          {isAiMethod ? 'AI parsing' : 'Auto parsing'}
        </span>
      </TableCell>
    </TableRow>
  )
}
