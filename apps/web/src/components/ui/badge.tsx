import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Бейджи из таблицы каналов (Admin.dc.html:160,163): Copy On/Off и Active Positions >0/0
// используют одну и ту же пару цветов «включено/выключено», отличаются только паддингом
// и минимальной шириной — вынесено в variant/size, чтобы не дублировать rgba-цвета.
const badgeVariants = cva('inline-flex items-center justify-center rounded-[5px] font-semibold', {
  variants: {
    variant: {
      on: 'bg-long-bg text-long',
      off: 'bg-white/[.06] text-secondary-3',
      offMuted: 'bg-white/[.05] text-muted-2',
    },
    size: {
      sm: 'px-[9px] py-[2px] text-[11px]',
      md: 'min-w-[22px] px-2 py-[2px] text-xs tabular-nums',
    },
  },
  defaultVariants: { variant: 'off', size: 'sm' },
})

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}
