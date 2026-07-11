import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ChannelDto } from 'shared/dto.js'
import { Badge } from '../components/ui/badge.js'
import { Card } from '../components/ui/card.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.js'
import { apiFetch } from '../lib/api.js'
import { useChannelStatsStream } from '../lib/ws.js'

// Порядок и ширины колонок — дословно из брифа задачи 11 / Admin.dc.html:140-148.
const COLUMNS: { label: string; width: string }[] = [
  { label: 'Channel', width: '24%' },
  { label: 'Copy', width: '12%' },
  { label: 'Win Rate', width: '11%' },
  { label: 'Actions', width: '10%' },
  { label: 'Active Positions', width: '10%' },
  { label: 'Messages', width: '11%' },
  { label: 'Trade size', width: '12%' },
  { label: 'Max lev', width: '12%' },
]

export default function ChannelsPage() {
  const navigate = useNavigate()
  const { data } = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiFetch<ChannelDto[]>('/channels'),
  })
  const channels = data ?? []

  // Win Rate в реалтайме (задача Ф4): подписка на комнаты ВСЕХ уже загруженных каналов — тот же
  // приём, что useActionsStream/usePositionsStream (apps/web/src/routes/actions.tsx/positions.tsx).
  useChannelStatsStream(channels.map((c) => c.id))

  return (
    <div className="flex w-full flex-col gap-[22px]">
      <div>
        <h2 className="m-0 mb-[5px] text-[22px] font-semibold tracking-[-0.02em] text-fg">
          Telegram Channels
        </h2>
        <p className="m-0 text-[13.5px] text-muted-1">
          Signal sources — the bot parses messages and extracts trade actions
        </p>
      </div>

      <Card data-m="tablecard" className="w-full overflow-hidden">
        <Table style={{ tableLayout: 'fixed', minWidth: '820px' }}>
          <TableHeader>
            <TableRow className="border-t-0">
              {COLUMNS.map((col, i) => (
                <TableHead
                  key={col.label}
                  style={{ width: col.width }}
                  className={i === 0 ? 'px-[22px]' : undefined}
                >
                  {col.label}
                </TableHead>
              ))}
              <TableHead style={{ width: '44px' }} className="px-[22px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.map((c) => (
              <TableRow
                key={c.id}
                onClick={() => navigate(`/channels/${c.id}`)}
                className="cursor-pointer hover:bg-white/[.025]"
              >
                <TableCell className="px-[22px]">
                  <div className="flex items-center gap-[13px]">
                    <div className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg bg-white/5 text-sm font-semibold text-secondary-1">
                      {c.initial}
                    </div>
                    <div className="min-w-0">
                      <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-fg">
                        {c.title}
                      </div>
                      <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-2">
                        {c.handle}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={c.copyEnabled ? 'on' : 'off'}>{c.copyEnabled ? 'On' : 'Off'}</Badge>
                </TableCell>
                <TableCell className="text-[13px] font-medium tabular-nums text-secondary-2">
                  {c.winRate}
                </TableCell>
                <TableCell className="text-[13px] font-semibold tabular-nums text-fg">
                  {c.actionCount}
                </TableCell>
                <TableCell>
                  <Badge variant={c.activePositions > 0 ? 'on' : 'offMuted'} size="md">
                    {c.activePositions}
                  </Badge>
                </TableCell>
                <TableCell className="text-[13px] font-medium tabular-nums text-secondary-2">
                  {c.messageCount}
                </TableCell>
                <TableCell className="font-mono text-[12.5px] text-secondary-1">{c.tradeSize}</TableCell>
                <TableCell className="px-[22px] font-mono text-[12.5px] text-secondary-1">
                  {c.maxLeverage}
                </TableCell>
                <TableCell className="px-[22px] text-right text-muted-3">
                  <ChevronRight size={16} className="ml-auto" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
