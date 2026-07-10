import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Поля Login/Password из Admin.dc.html:57,61 — высота 40px, фон белый 4%, рамка белая 10%.
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-white/10 bg-white/[.04] px-[13px] font-sans text-[13.5px] text-fg outline-none placeholder:text-muted-1 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
