import { useQuery } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { Timer, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PendingOrderDto } from 'shared/dto.js'
import { TableStateRow } from './TableStateRow.js'
import { Card } from './ui/card.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js'
import { apiFetch } from '../lib/api.js'
import { cn } from '../lib/utils.js'

/** Ключ запроса списка отложенных лимиток — экспортирован (тот же приём, что POSITIONS_LIST_KEY
 *  в routes/positions.tsx), чтобы lib/ws.ts мог инвалидировать его по любому событию
 *  order.resolved/position.upsert, не зная деталей компонента. */
export const PENDING_ORDERS_KEY = 'orders-pending'

export function pendingOrdersQueryKey(): QueryKey {
  return [PENDING_ORDERS_KEY]
}

// Task-3-brief.md: без готового WS-события на КАЖДЫЙ случай схода лимитки со сцены (TTL-свип
// dry-run — apps/engine/src/main.ts::sweepExpiredLimitOrders — молча помечает cancelled в БД,
// НЕ публикуя domain_events; ни DryRunAdapter.cancelOrder, ни BybitAdapter.cancelOrder этого не
// делают — см. apps/engine/src/execution/*.adapter.ts). order.resolved (задача 3, Ф3) реально
// прилетает только на пуш `order.linear` от приватного WS Bybit (реальные fill/cancel в live-режиме) —
// в dry-run такого потока нет вовсе. Лёгкий polling каждые 5с — простой и достаточный фолбэк
// (список обычно пуст или содержит единицы строк, не нагрузка по частоте, как mark-price тики
// Positions): подхватит и TTL-истечение, и dry-run филлы, и live-события, которые почему-то не
// доехали по WS. lib/ws.ts ДОПОЛНИТЕЛЬНО (не вместо) инвалидирует этот же ключ на 'order.resolved' —
// в live-режиме обновление придёт быстрее, чем за 5с.
const POLL_INTERVAL_MS = 5000

async function fetchPendingOrders(): Promise<PendingOrderDto[]> {
  return apiFetch<PendingOrderDto[]>('/orders/pending')
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
// Порог "скоро истекает" — подсветка тем же красным, что и отрицательный PnL на Positions.
const URGENT_MS = 5 * MINUTE_MS

/** '4m 12s' / '3h 8m' / '2d 5h' / 'expired' — обратный отсчёт до эффективного TTL-дедлайна
 *  (PendingOrderDto.ttlExpiresAt, уже посчитан на бэкенде с fallback'ом на channel_settings.
 *  limit_ttl_sec). Градация единиц — по обычному дефолту limit_ttl_sec=604800с (7 дней)
 *  большинство строк показывали бы бесполезные "10080m 0s" без укрупнения до дней/часов. */
export function formatTtl(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired'

  const totalSeconds = Math.floor(remainingMs / 1000)
  const days = Math.floor(remainingMs / DAY_MS)
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds}s`
}

/** Тикает раз в секунду (useEffect + setInterval, чистка на unmount — бриф задачи явно просит
 *  именно этот приём) — общий "текущий момент" для всех строк таблицы, а не отдельный таймер
 *  на строку: одна перерисовка секунды на весь список, не N. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

const PURPOSE_LABEL: Record<string, string> = { entry: 'Entry', add: 'Add' }

/**
 * Секция "Pending limit orders" (task-3-brief.md) — отложенные лимитки на вход (submitted,
 * reduce_only=false, purpose IN entry/add), встроена под основной таблицей Positions
 * (design/project/Admin.dc.html не содержит отдельного pending-экрана — спека §12, это
 * минимальное решение: секция, переиспользующая 1:1 стиль карточки/таблицы Positions, а не
 * отдельный роут/таб в сайдбаре). TP/SL сюда не попадают — они уже показаны как часть позиции.
 */
export function PendingOrders() {
  const now = useNowTick()
  const { data, isPending, isError } = useQuery({
    queryKey: pendingOrdersQueryKey(),
    queryFn: fetchPendingOrders,
    refetchInterval: POLL_INTERVAL_MS,
  })
  const orders = data ?? []

  return (
    <div className="flex w-full flex-col gap-[13px]">
      <div>
        <h3 className="m-0 mb-[4px] text-[15px] font-semibold tracking-[-0.02em] text-fg">Pending limit orders</h3>
        <p className="m-0 text-[12.5px] text-muted-1">
          Submitted entry/add limit orders awaiting fill — auto-cancelled when their TTL expires.
        </p>
      </div>

      <Card data-m="pendingcard" className="w-full overflow-hidden">
        <Table style={{ tableLayout: 'fixed', minWidth: '820px' }}>
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead className="px-[22px]" style={{ width: '13%' }}>
                Symbol
              </TableHead>
              <TableHead style={{ width: '11%' }}>Side</TableHead>
              <TableHead style={{ width: '11%' }}>Purpose</TableHead>
              <TableHead style={{ width: '13%' }}>Price</TableHead>
              <TableHead style={{ width: '11%' }}>Qty</TableHead>
              <TableHead style={{ width: '20%' }}>Channel</TableHead>
              <TableHead className="px-[22px]" style={{ width: '21%' }}>
                TTL
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <PendingOrderRow key={o.id} order={o} now={now} />
            ))}
          </TableBody>
        </Table>
        <TableStateRow
          isPending={isPending}
          isError={isError}
          isEmpty={orders.length === 0}
          emptyMessage="No pending limit orders."
          errorMessage="Failed to load pending orders. Please try again."
        />
      </Card>
    </div>
  )
}

function PendingOrderRow({ order: o, now }: { order: PendingOrderDto; now: number }) {
  const isLong = o.side === 'long'
  const DirIcon = isLong ? TrendingUp : TrendingDown
  const remainingMs = new Date(o.ttlExpiresAt).getTime() - now
  const ttlLabel = formatTtl(remainingMs)
  const urgent = remainingMs > 0 && remainingMs <= URGENT_MS
  const expired = remainingMs <= 0

  return (
    <TableRow className="hover:bg-white/[.02]">
      <TableCell className="px-[22px] font-mono text-[13px] font-semibold text-fg">{o.symbol}</TableCell>
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
      <TableCell className="text-[12.5px] text-secondary-1">{PURPOSE_LABEL[o.purpose] ?? o.purpose}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{o.price}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{o.qty}</TableCell>
      <TableCell>
        <span className="flex flex-col gap-[1px]">
          <span className="whitespace-nowrap text-[12.5px] text-secondary-1">{o.channelTitle}</span>
          {o.tradeRef ? <span className="font-mono text-[11px] text-muted-2">{o.tradeRef}</span> : null}
        </span>
      </TableCell>
      <TableCell className="px-[22px]">
        <span
          className={cn(
            'inline-flex items-center gap-[6px] font-mono text-[12.5px] font-semibold',
            expired || urgent ? 'text-short' : 'text-secondary-1',
          )}
        >
          <Timer size={14} className="flex-none" />
          {ttlLabel}
        </span>
      </TableCell>
    </TableRow>
  )
}
