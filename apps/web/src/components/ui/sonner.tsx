import { Toaster as Sonner } from 'sonner'
import type { ComponentProps } from 'react'

// Тема жёстко тёмная (см. CLAUDE.md/бриф — светлой темы нет), поэтому Toaster всегда в theme="dark".
export function Toaster(props: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        style: {
          background: 'var(--color-card)',
          border: '1px solid var(--color-border-card)',
          color: 'var(--color-fg)',
        },
      }}
      {...props}
    />
  )
}
