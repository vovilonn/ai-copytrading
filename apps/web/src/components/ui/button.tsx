import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Варианты 1 к 1 с кнопками из Admin.dc.html: акцентная (Sign in, Save changes) —
// bg accent/hover accent-hover, чёрный текст; outline (Logout) — прозрачная с рамкой.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-lg font-sans font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-[#0a0a0a] hover:bg-accent-hover',
        outline:
          'border border-white/10 bg-transparent text-secondary-2 hover:bg-white/5 hover:text-fg font-medium',
        ghost: 'bg-transparent text-secondary-3 hover:bg-white/[.04] hover:text-fg font-medium',
      },
      size: {
        default: 'h-[42px] px-4 text-sm',
        sm: 'h-[34px] px-[13px] text-[12.5px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    )
  },
)
Button.displayName = 'Button'
