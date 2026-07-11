import { TrendingDown, TrendingUp } from 'lucide-react'
import type { ClosedTradeDto } from 'shared/dto.js'
import { LoadMore } from './LoadMore.js'
import { TableStateRow } from './TableStateRow.js'
import { Card } from './ui/card.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js'
import { apiFetch } from '../lib/api.js'
import { cn } from '../lib/utils.js'
import { type Cursor, useCursorList } from '../lib/use-cursor-list.js'

// Task 4 (мониторинг): вкладка Closed на Positions — закрытые/отменённые сделки из
// GET /positions/history (bare-array ClosedTradeDto[], курсор before=tradeRef — сырой human_ref
// 'TR-1042', см. brief). Пагинация — тот же useCursorList/<LoadMore/>, что и Open-таблица.
const PAGE_SIZE = 50

export function closedTradesQueryKey(): readonly unknown[] {
  return ['positions-history']
}

async function fetchHistory(before: Cursor | undefined): Promise<ClosedTradeDto[]> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (before !== undefined) params.set('before', String(before))
  return apiFetch<ClosedTradeDto[]>(`/positions/history?${params.toString()}`)
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** '2h 14m' / '3d 5h' / '18m' — человекочитаемая длительность сделки (ClosedTradeDto.durationMs,
 *  посчитан на бэкенде). Укрупняется до дней/часов, как formatTtl в PendingOrders, но без секунд:
 *  сделки живут минутами—днями, посекундная точность здесь визуальный шум. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function isNegative(signed: string): boolean {
  return signed.startsWith('-')
}

// Бейдж причины закрытия — цвет по семантике: TP зелёный (профит-таргет), SL/ликвидация красные
// (стоп/принудительно), manual нейтральный, cancelled жёлтый (несостоявшаяся лимитка, не результат).
const REASON_BADGE: Record<NonNullable<ClosedTradeDto['closeReason']>, { label: string; className: string }> = {
  tp: { label: 'TP', className: 'bg-long-bg text-long' },
  sl: { label: 'SL', className: 'bg-[rgba(251,113,133,.13)] text-short' },
  liquidation: { label: 'Liquidation', className: 'bg-[rgba(251,113,133,.13)] text-short' },
  manual: { label: 'Manual', className: 'bg-white/[.06] text-secondary-2' },
  cancelled: { label: 'Cancelled', className: 'bg-skipped-bg text-skipped' },
}

export function ClosedTradesTable() {
  const { items, fetchNextPage, hasNextPage, isFetchingNextPage, isPending, isError } = useCursorList<ClosedTradeDto>({
    queryKey: closedTradesQueryKey(),
    fetchPage: fetchHistory,
    getCursor: (t) => t.tradeRef,
    pageSize: PAGE_SIZE,
  })

  return (
    <div className="flex w-full flex-col gap-[13px]">
      <Card data-m="closedcard" className="w-full overflow-hidden">
        <Table style={{ tableLayout: 'fixed', minWidth: '980px' }}>
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead className="px-[22px]" style={{ width: '12%' }}>
                Symbol
              </TableHead>
              <TableHead style={{ width: '10%' }}>Side</TableHead>
              <TableHead style={{ width: '10%' }}>Entry</TableHead>
              <TableHead style={{ width: '10%' }}>Exit</TableHead>
              <TableHead style={{ width: '12%' }}>Realized PnL</TableHead>
              <TableHead style={{ width: '11%' }}>Reason</TableHead>
              <TableHead style={{ width: '9%' }}>Duration</TableHead>
              <TableHead style={{ width: '16%' }}>Channel</TableHead>
              <TableHead className="px-[22px]" style={{ width: '10%' }}>
                Result
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => (
              <ClosedTradeRow key={t.tradeRef} trade={t} />
            ))}
          </TableBody>
        </Table>
        <TableStateRow
          isPending={isPending}
          isError={isError}
          isEmpty={items.length === 0}
          emptyMessage="No closed trades yet."
          errorMessage="Failed to load closed trades. Please try again."
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

function ResultBadge({ isWin }: { isWin: boolean | null }) {
  if (isWin === null) {
    return <span className="text-[12.5px] text-muted-2">—</span>
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[5px] px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[.04em]',
        isWin ? 'bg-long-bg text-long' : 'bg-[rgba(251,113,133,.13)] text-short',
      )}
    >
      {isWin ? 'Win' : 'Loss'}
    </span>
  )
}

function ClosedTradeRow({ trade: t }: { trade: ClosedTradeDto }) {
  const isLong = t.side === 'long'
  const DirIcon = isLong ? TrendingUp : TrendingDown
  const pnlNegative = isNegative(t.realizedPnl)
  const reason = t.closeReason ? REASON_BADGE[t.closeReason] : null

  return (
    <TableRow className="hover:bg-white/[.02]">
      <TableCell className="px-[22px] font-mono text-[13px] font-semibold text-fg">{t.symbol}</TableCell>
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
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{t.avgEntry}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-message">{t.exitPrice ?? '—'}</TableCell>
      <TableCell>
        <span className={cn('font-mono text-[13px] font-semibold', pnlNegative ? 'text-short' : 'text-long')}>
          {t.realizedPnl}
        </span>
      </TableCell>
      <TableCell>
        {reason ? (
          <span
            className={cn(
              'inline-flex items-center rounded-[5px] px-2 py-[3px] text-[10.5px] font-bold uppercase tracking-[.04em]',
              reason.className,
            )}
          >
            {reason.label}
          </span>
        ) : (
          <span className="text-[12.5px] text-muted-2">—</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-3">{formatDuration(t.durationMs)}</TableCell>
      <TableCell>
        <span className="flex flex-col gap-[1px]">
          <span className="whitespace-nowrap text-[12.5px] text-secondary-1">{t.channelTitle}</span>
          <span className="font-mono text-[11px] text-muted-2">{t.tradeRef}</span>
        </span>
      </TableCell>
      <TableCell className="px-[22px]">
        <ResultBadge isWin={t.isWin} />
      </TableCell>
    </TableRow>
  )
}
