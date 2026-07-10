import { cn } from '../lib/utils.js'

export interface SegmentOption {
  value: string
  label: string
}

interface SegmentedControlProps {
  /** Надпись слева от пилюли (Admin.dc.html:317,324,330,336: 'Channel'/'Period'/'Type'/'Side'). */
  label: string
  options: SegmentOption[]
  value: string
  onChange: (value: string) => void
  /** Channel-фильтр переносит кнопки на новую строку при нехватке места (channelOpts,
   *  Admin.dc.html:318: `flex-wrap:wrap`) — Period/Type/Side/Side этого не делают. */
  wrap?: boolean
}

// Сегмент-контрол (design: `segBtn`, Admin.dc.html:701-706 + контейнер 318/325/331/337) —
// переиспользуемый фильтр-переключатель: страница Actions использует его 4 раза
// (Channel/Period/Type/Side), Positions (задача 10) — под те же Channel/Side/Margin.
export function SegmentedControl({ label, options, value, onChange, wrap = false }: SegmentedControlProps) {
  return (
    <div className="flex items-center gap-[9px]">
      <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-muted-1">{label}</span>
      <div
        className={cn(
          'inline-flex gap-0.5 rounded-lg border border-white/[.09] bg-white/[.04] p-[3px]',
          wrap ? 'flex-wrap' : undefined,
        )}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'cursor-pointer whitespace-nowrap rounded-md px-[13px] py-[5px] font-sans text-xs',
              o.value === value
                ? 'bg-white/[.09] font-semibold text-fg'
                : 'bg-transparent font-medium text-secondary-3',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
