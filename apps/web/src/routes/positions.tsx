import { useQuery } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { Search, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ChannelDto, PositionDto, PositionStatsDto } from 'shared/dto.js'
import { AccountPanelsGrid } from '../components/AccountPanels.js'
import { ClosedTradesTable } from '../components/ClosedTradesTable.js'
import { LoadMore } from '../components/LoadMore.js'
import { PendingOrders } from '../components/PendingOrders.js'
import { SegmentedControl, type SegmentOption } from '../components/SegmentedControl.js'
import { TableStateRow } from '../components/TableStateRow.js'
import { Card } from '../components/ui/card.js'
import { Input } from '../components/ui/input.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js'
import { apiFetch } from '../lib/api.js'
import { type Cursor, useCursorList } from '../lib/use-cursor-list.js'
import { cn } from '../lib/utils.js'
import { usePendingOrdersStream, usePositionsStream } from '../lib/ws.js'

// design/project/Admin.dc.html:712-713 (posSideOpts/posMarginOpts) — те же значения, что
// принимает GET /api/positions (side/margin, positions.service.ts).
const SIDE_OPTIONS: SegmentOption[] = [
  { value: 'all', label: 'All' },
  { value: 'long', label: 'LONG' },
  { value: 'short', label: 'SHORT' },
]
const MARGIN_OPTIONS: SegmentOption[] = [
  { value: 'all', label: 'All' },
  { value: 'cross', label: 'Cross' },
  { value: 'isolated', label: 'Isolated' },
]

// Task 4 (мониторинг): вкладки Open/Closed над таблицей — ?status= в URL (open — дефолт).
const VIEW_OPTIONS: SegmentOption[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
]

// Task 4: первая страница keyset-пагинации Positions (useCursorList, курсор before=PositionDto.id).
// Экспортирован: lib/ws.ts (F7-фикс) должен знать точный pageSize, чтобы решить, могло ли
// локальное удаление строки (size=0) срезать последнюю страницу ровно с границы hasNextPage.
export const POSITIONS_PAGE_SIZE = 50

export interface PositionsFilters {
  channel: string
  side: string
  margin: string
  q: string
}

/** Префикс ключа запроса списка позиций — экспортирован, чтобы usePositionsStream (lib/ws.ts)
 *  мог точечно патчить кэш ЛЮБОГО активного набора фильтров сразу (queryClient.setQueriesData
 *  с partial-match по этому префиксу), не зная текущих filters страницы. Тот же приём, что
 *  messagesQueryKey в components/MessageTimeline.tsx, импортируемый в lib/ws.ts — там ключ точный
 *  (один channelId), здесь — префикс, т.к. вариантов filters может быть несколько.
 *  Task 4: под этим ключом теперь лежит InfiniteData<PositionDto[]> (useCursorList), а не голый
 *  PositionDto[] — usePositionsStream патчит его постранично. */
export const POSITIONS_LIST_KEY = 'positions'

export function positionsQueryKey(filters: PositionsFilters): QueryKey {
  return [POSITIONS_LIST_KEY, filters]
}

/** Ключ агрегатов — сознательно НЕ префикс ['positions', ...] (а отдельный литерал), иначе
 *  queryClient.setQueriesData({queryKey:['positions']}) в lib/ws.ts задел бы и его тоже. */
export function positionsStatsQueryKey(): QueryKey {
  return ['positions-stats']
}

async function fetchPositions(filters: PositionsFilters, before: Cursor | undefined): Promise<PositionDto[]> {
  const params = new URLSearchParams()
  if (filters.channel !== 'all') params.set('channel', filters.channel)
  if (filters.side !== 'all') params.set('side', filters.side)
  if (filters.margin !== 'all') params.set('margin', filters.margin)
  if (filters.q.trim()) params.set('q', filters.q.trim())
  params.set('limit', String(POSITIONS_PAGE_SIZE))
  if (before !== undefined) params.set('before', String(before))
  return apiFetch<PositionDto[]>(`/positions?${params.toString()}`)
}

async function fetchPositionsStats(): Promise<PositionStatsDto> {
  return apiFetch<PositionStatsDto>('/positions/stats')
}

function isNegative(signed: string): boolean {
  return signed.startsWith('-')
}

interface StatDef {
  label: string
  value: string
  sub: string
  /** true — денежная карточка PnL (красится по знаку); false — нейтральная (белая). */
  colored: boolean
  negative: boolean
}

// Task 4: расширено глобальными PnL-карточками realized/total поверх исходной Ф1-четвёрки
// (openPositions/unrealised/positionValue/marginUsed). totalPnl = unrealised(open)+realized(closed),
// считает backend (positions.service.ts::getStats) — фронт только красит по знаку.
function buildStats(stats: PositionStatsDto): StatDef[] {
  return [
    { label: 'Open positions', value: String(stats.openPositions), sub: 'across all channels', colored: false, negative: false },
    {
      label: 'Unrealised PnL',
      value: stats.unrealisedPnl,
      sub: 'live mark-to-market',
      colored: true,
      negative: isNegative(stats.unrealisedPnl),
    },
    {
      label: 'Realized PnL',
      value: stats.realizedPnl,
      sub: 'booked on closed trades',
      colored: true,
      negative: isNegative(stats.realizedPnl),
    },
    {
      label: 'Total PnL',
      value: stats.totalPnl,
      sub: 'realised + unrealised',
      colored: true,
      negative: isNegative(stats.totalPnl),
    },
    { label: 'Position value', value: stats.positionValue, sub: 'total notional', colored: false, negative: false },
    { label: 'Margin used', value: stats.marginUsed, sub: 'initial margin', colored: false, negative: false },
  ]
}

// Страница Positions (design/project/Admin.dc.html:394-475) — зеркало Bybit /v5/position/list с
// живым mark price (engine/src/market-data). Task 4: + вкладки Open/Closed, keyset-пагинация,
// панели PnL/баланса.
export default function PositionsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // ?tr=<ref> (goTrade в дизайне, Admin.dc.html:504) предзаполняет поиск — нормализуем в
  // канонический ?q= ОДИН раз при монтировании, дальше поиск живёт как обычный фильтр `q`
  // (та же логика, что уже привела сюда пользователя с Actions: navigate(`/positions?tr=...`)).
  useEffect(() => {
    const tr = searchParams.get('tr')
    if (tr === null) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('tr')
        next.set('q', tr)
        return next
      },
      { replace: true },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const view = searchParams.get('status') === 'closed' ? 'closed' : 'open'
  const channel = searchParams.get('channel') ?? 'all'
  const side = searchParams.get('side') ?? 'all'
  const margin = searchParams.get('margin') ?? 'all'
  const q = searchParams.get('q') ?? searchParams.get('tr') ?? ''

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

  // Дебаунс поиска 300мс — тот же приём, что и на странице Actions (actions.tsx).
  const [pendingQuery, setPendingQuery] = useState(q)
  useEffect(() => setPendingQuery(q), [q])
  useEffect(() => {
    if (pendingQuery === q) return
    const timer = setTimeout(() => setFilter('q', pendingQuery), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuery])

  const { data: channelsData } = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiFetch<ChannelDto[]>('/channels'),
  })
  const channels = channelsData ?? []
  // Реалтайм (задача 10): position.upsert летит в комнату channel:<id> (тот же шлюз, что и
  // action.new/action.skipped) — подписываемся на комнаты ВСЕХ каналов, как useActionsStream.
  usePositionsStream(channels.map((c) => c.id))
  // Задача 3 (Ф4): order.resolved ускоряет обновление секции Pending в live-режиме — polling
  // внутри PendingOrders (lib/ws.ts::usePendingOrdersStream) остаётся основным фолбэком.
  usePendingOrdersStream(channels.map((c) => c.id))

  const filters: PositionsFilters = { channel, side, margin, q }
  const {
    items: positions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isPositionsPending,
    isError: isPositionsError,
  } = useCursorList<PositionDto>({
    queryKey: positionsQueryKey(filters),
    fetchPage: (before) => fetchPositions(filters, before),
    getCursor: (p) => p.id,
    pageSize: POSITIONS_PAGE_SIZE,
    // Task 4: список открытых позиций не нужен на вкладке Closed — не гоняем GET впустую.
    enabled: view === 'open',
  })

  const { data: statsData } = useQuery({
    queryKey: positionsStatsQueryKey(),
    queryFn: fetchPositionsStats,
  })
  const stats = statsData ? buildStats(statsData) : []

  const channelOptions: SegmentOption[] = [
    { value: 'all', label: 'All channels' },
    ...channels.map((c) => ({ value: String(c.id), label: c.title })),
  ]

  return (
    <div className="flex w-full flex-col gap-[22px]">
      <div>
        <h2 className="m-0 mb-[5px] text-[22px] font-semibold tracking-[-0.02em] text-fg">Positions</h2>
        <p className="m-0 text-[13.5px] text-muted-1">Open positions on Bybit — synced from /v5/position/list</p>
      </div>

      <div className="grid gap-[14px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex min-w-[180px] flex-1 flex-col gap-[7px] rounded-[10px] border border-card-border bg-card p-[16px_18px]"
          >
            <span className="text-[12px] font-medium text-muted-1">{s.label}</span>
            <span
              data-testid={`stat-value-${s.label}`}
              className={cn(
                'text-[22px] font-bold tracking-[-0.02em]',
                s.colored ? (s.negative ? 'text-short' : 'text-long') : 'text-fg',
              )}
            >
              {s.value}
            </span>
            <span className="text-[11.5px] text-muted-2">{s.sub}</span>
          </div>
        ))}
      </div>

      {/* Task 4: панели баланса аккаунта и PnL по каналам — глобальный мониторинг, видны на обеих
          вкладках (свои независимые запросы /account/wallet и /positions/stats/by-channel). */}
      <AccountPanelsGrid />

      <SegmentedControl
        label="View"
        options={VIEW_OPTIONS}
        value={view}
        onChange={(v) => setFilter('status', v === 'open' ? '' : v)}
      />

      {view === 'open' ? (
        <>
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
                label="Side"
                options={SIDE_OPTIONS}
                value={side}
                onChange={(v) => setFilter('side', v)}
              />
              <SegmentedControl
                label="Margin"
                options={MARGIN_OPTIONS}
                value={margin}
                onChange={(v) => setFilter('margin', v)}
              />
              <div className="relative ml-auto flex items-center" data-m="searchwrap">
                <Search size={15} className="pointer-events-none absolute left-[11px] text-muted-2" />
                <Input
                  value={pendingQuery}
                  onChange={(e) => setPendingQuery(e.target.value)}
                  placeholder="Symbol, channel or #TR-ID…"
                  className="h-[34px] w-[230px] rounded-[7px] pl-[33px] pr-3 text-[12.5px]"
                />
              </div>
            </div>
          </div>

          <div className="flex w-full flex-col gap-[13px]">
            <Card data-m="tablecard" className="w-full overflow-hidden">
              <Table style={{ tableLayout: 'fixed', minWidth: '940px' }}>
                <TableHeader>
                  <TableRow className="border-t-0">
                    <TableHead className="px-[22px]" style={{ width: '12%' }}>
                      Symbol
                    </TableHead>
                    <TableHead style={{ width: '10%' }}>Side</TableHead>
                    <TableHead style={{ width: '11%' }}>Size</TableHead>
                    <TableHead style={{ width: '9%' }}>Entry</TableHead>
                    <TableHead style={{ width: '9%' }}>Mark</TableHead>
                    <TableHead style={{ width: '9%' }}>Liq. price</TableHead>
                    <TableHead style={{ width: '11%' }}>Unreal. PnL</TableHead>
                    <TableHead style={{ width: '10%' }}>TP / SL</TableHead>
                    <TableHead style={{ width: '11%' }}>Leverage</TableHead>
                    <TableHead className="px-[22px]" style={{ width: '14%' }}>
                      Source
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {positions.map((p) => (
                    <PositionTableRow
                      key={p.id}
                      position={p}
                      onSourceClick={() => navigate(`/channels/${p.channelId}`)}
                    />
                  ))}
                </TableBody>
              </Table>
              <TableStateRow
                isPending={isPositionsPending}
                isError={isPositionsError}
                isEmpty={positions.length === 0}
                emptyMessage="No positions match the selected filters."
                errorMessage="Failed to load positions. Please try again."
              />
            </Card>
            <LoadMore
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={() => void fetchNextPage()}
            />
          </div>

          {/* Задача 3 (Ф4, task-3-brief.md): отложенные лимитки на вход с обратным отсчётом TTL —
              секция под таблицей открытых позиций (не отдельный роут). Независима от фильтров. */}
          <PendingOrders />
        </>
      ) : (
        <ClosedTradesTable />
      )}
    </div>
  )
}

interface PositionTableRowProps {
  position: PositionDto
  onSourceClick: () => void
}

function PositionTableRow({ position: p, onSourceClick }: PositionTableRowProps) {
  const isLong = p.side === 'long'
  const DirIcon = isLong ? TrendingUp : TrendingDown
  const pnlNegative = isNegative(p.unrealisedPnl)

  return (
    <TableRow className="hover:bg-white/[.02]">
      <TableCell className="px-[22px] font-mono text-[13px] font-semibold text-fg">{p.symbol}</TableCell>
      <TableCell>
        <span
          className={cn(
            'inline-flex items-center gap-[6px] text-[12px] font-semibold tracking-[.02em]',
            isLong ? 'text-long' : 'text-short',
          )}
        >
          <DirIcon size={14} className="flex-none" />
          {isLong ? 'LONG' : 'SHORT'}
        </span>
      </TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{p.size}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{p.entry}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-message">{p.mark}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-3">{p.liq ?? '—'}</TableCell>
      <TableCell>
        <span className="flex flex-col gap-[1px]">
          <span className={cn('font-mono text-[13px] font-semibold', pnlNegative ? 'text-short' : 'text-long')}>
            {p.unrealisedPnl}
          </span>
          <span className={cn('font-mono text-[11.5px] opacity-80', pnlNegative ? 'text-short' : 'text-long')}>
            {p.roi}
          </span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex flex-col gap-[1px] font-mono text-[11px]">
          <span className="text-long">TP {p.tp ?? '—'}</span>
          <span className="text-short">SL {p.sl ?? '—'}</span>
        </span>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-[7px] font-mono text-[12.5px] text-secondary-1">
          {p.leverage}
          <span className="rounded-[4px] bg-white/[.06] px-[6px] py-[1px] text-[10.5px] font-semibold text-secondary-3">
            {p.marginMode}
          </span>
        </span>
      </TableCell>
      <TableCell className="px-[22px]">
        <span className="flex flex-col gap-[1px]">
          <span
            data-testid="position-source"
            onClick={onSourceClick}
            className="cursor-pointer whitespace-nowrap text-[12.5px] text-secondary-1 hover:text-accent-hover"
          >
            {p.source}
          </span>
          {p.tradeRef ? <span className="font-mono text-[11px] text-muted-2">{p.tradeRef}</span> : null}
        </span>
      </TableCell>
    </TableRow>
  )
}
