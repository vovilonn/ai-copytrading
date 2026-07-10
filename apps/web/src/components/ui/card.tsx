import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Карточка/обёртка таблицы (Admin.dc.html:136,252): фон card, рамка card-border,
// радиус 10px. Используется как обёртка таблицы каналов и (позже) карточек настроек.
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-[10px] border border-card-border bg-card', className)}
      {...props}
    />
  ),
)
Card.displayName = 'Card'
