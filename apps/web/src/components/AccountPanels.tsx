import { useQuery } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import type { AccountWalletDto, ChannelPnlDto } from 'shared/dto.js'
import { TableStateRow } from './TableStateRow.js'
import { Card } from './ui/card.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js'
import { apiFetch } from '../lib/api.js'
import { cn } from '../lib/utils.js'

// Task 4 (мониторинг PnL/баланса): три панели статистики поверх Positions — глобальные PnL-карточки
// (в самом routes/positions.tsx через buildStats), карточка баланса аккаунта (WalletCard) и мини-
// таблица PnL по каналам (ChannelPnlTable). Стиль 1:1 с существующими карточками/PendingOrders.tsx.

export function accountWalletQueryKey(): readonly unknown[] {
  return ['account-wallet']
}
export function channelPnlQueryKey(): readonly unknown[] {
  return ['positions-stats-by-channel']
}

function isNegative(signed: string): boolean {
  return signed.startsWith('-')
}

const asOfFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Баланс demo-аккаунта — GET /account/wallet (AccountWalletDto). asOf=null или totalEquity='$0.00'
 * ⇒ движок ещё не записал ни одного wallet-снапшота (dry-run / только что переключились на live):
 * показываем плейсхолдер «нет данных о балансе», а НЕ нулевой баланс (иначе оператор подумает, что
 * счёт пуст). Реальные значения появятся после live-переключения (Task 5 плана).
 */
export function WalletCard() {
  const { data, isPending, isError } = useQuery({
    queryKey: accountWalletQueryKey(),
    queryFn: () => apiFetch<AccountWalletDto>('/account/wallet'),
  })

  const hasBalance = data != null && data.asOf !== null && data.totalEquity !== '$0.00'

  return (
    <Card data-m="walletcard" className="flex flex-col gap-[14px] p-[18px_20px]">
      <div className="flex items-center gap-[9px]">
        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-white/5">
          <Wallet size={15} className="text-accent-hover" />
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-fg">Account balance</span>
      </div>

      {isPending ? (
        <span className="text-[13px] text-muted-1">Loading…</span>
      ) : isError ? (
        <span className="text-[13px] text-short">Failed to load balance. Please try again.</span>
      ) : !hasBalance ? (
        <div className="flex flex-col gap-[4px]">
          <span data-testid="wallet-empty" className="text-[14px] font-medium text-secondary-3">
            No balance data yet
          </span>
          <span className="text-[11.5px] text-muted-2">Appears once the engine goes live on Bybit demo.</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-[36px] gap-y-[14px]">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[11.5px] font-medium text-muted-1">Total equity</span>
            <span data-testid="wallet-equity" className="font-mono text-[22px] font-bold tracking-[-0.02em] text-fg">
              {data.totalEquity}
            </span>
            <span className="text-[11px] text-muted-2">{data.currency}</span>
          </div>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[11.5px] font-medium text-muted-1">Available</span>
            <span className="font-mono text-[22px] font-bold tracking-[-0.02em] text-secondary-1">
              {data.availableBalance}
            </span>
            {data.asOf ? (
              <span className="text-[11px] text-muted-2">as of {asOfFormatter.format(new Date(data.asOf))}</span>
            ) : null}
          </div>
        </div>
      )}
    </Card>
  )
}

/**
 * PnL по каналам — GET /positions/stats/by-channel (ChannelPnlDto[]). Виртуальная разбивка одного
 * demo-аккаунта по каналам-источникам (реальных субаккаунтов на demo нет, см. план). Пустая таблица
 * (нет открытых позиций и закрытых сделок ни по одному каналу) — обычное пустое состояние.
 */
export function ChannelPnlTable() {
  const { data, isPending, isError } = useQuery({
    queryKey: channelPnlQueryKey(),
    queryFn: () => apiFetch<ChannelPnlDto[]>('/positions/stats/by-channel'),
  })
  const rows = data ?? []

  return (
    <div className="flex w-full flex-col gap-[13px]">
      <div>
        <h3 className="m-0 mb-[4px] text-[15px] font-semibold tracking-[-0.02em] text-fg">PnL by channel</h3>
        <p className="m-0 text-[12.5px] text-muted-1">
          Open, realised and total PnL per source channel — plus win rate on decided trades.
        </p>
      </div>

      <Card data-m="channelpnlcard" className="w-full overflow-hidden">
        <Table style={{ tableLayout: 'fixed', minWidth: '760px' }}>
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead className="px-[22px]" style={{ width: '26%' }}>
                Channel
              </TableHead>
              <TableHead style={{ width: '11%' }}>Open</TableHead>
              <TableHead style={{ width: '16%' }}>Unrealised</TableHead>
              <TableHead style={{ width: '16%' }}>Realized</TableHead>
              <TableHead style={{ width: '16%' }}>Total</TableHead>
              <TableHead className="px-[22px]" style={{ width: '11%' }}>
                Win Rate
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <ChannelPnlRow key={c.channelId} row={c} />
            ))}
          </TableBody>
        </Table>
        <TableStateRow
          isPending={isPending}
          isError={isError}
          isEmpty={rows.length === 0}
          emptyMessage="No PnL recorded for any channel yet."
          errorMessage="Failed to load per-channel PnL. Please try again."
        />
      </Card>
    </div>
  )
}

/** Секция статистики поверх Positions: карточка баланса аккаунта + мини-таблица PnL по каналам,
 *  вертикально (баланс — узкая карточка, таблица под ней на всю ширину). */
export function AccountPanelsGrid() {
  return (
    <div className="flex w-full flex-col gap-[22px]">
      <WalletCard />
      <ChannelPnlTable />
    </div>
  )
}

function PnlCell({ value }: { value: string }) {
  return (
    <TableCell className={cn('font-mono text-[12.5px] font-semibold', isNegative(value) ? 'text-short' : 'text-long')}>
      {value}
    </TableCell>
  )
}

function ChannelPnlRow({ row: c }: { row: ChannelPnlDto }) {
  return (
    <TableRow className="hover:bg-white/[.02]">
      <TableCell className="px-[22px] text-[12.5px] text-secondary-1">{c.channelTitle}</TableCell>
      <TableCell className="font-mono text-[12.5px] text-secondary-1">{c.openPositions}</TableCell>
      <PnlCell value={c.unrealisedPnl} />
      <PnlCell value={c.realizedPnl} />
      <PnlCell value={c.totalPnl} />
      <TableCell className="px-[22px] font-mono text-[12.5px] text-secondary-1">{c.winRate}</TableCell>
    </TableRow>
  )
}
