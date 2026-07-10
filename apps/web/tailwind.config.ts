import animate from 'tailwindcss-animate'
import type { Config } from 'tailwindcss'

// Дизайн-токены 1 к 1 из design/project/Admin.dc.html — заведены как CSS-переменные
// в src/index.css и подключены сюда именованными утилитами (bg-card, text-muted-1, ...),
// чтобы во всех компонентах использовать классы, а не хардкодить hex-цвета повторно.
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Exo 2"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'Menlo', 'monospace'],
      },
      width: {
        sidebar: '246px',
      },
      height: {
        topbar: '60px',
      },
      colors: {
        bg: 'var(--color-bg)',
        card: 'var(--color-card)',
        'card-border': 'var(--color-border-card)',
        'row-border': 'var(--color-border-row)',
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--color-accent-hover)',
        },
        fg: 'var(--color-fg)',
        message: 'var(--color-message)',
        'secondary-1': 'var(--color-secondary-1)',
        'secondary-2': 'var(--color-secondary-2)',
        'secondary-3': 'var(--color-secondary-3)',
        'muted-1': 'var(--color-muted-1)',
        'muted-2': 'var(--color-muted-2)',
        'muted-3': 'var(--color-muted-3)',
        long: 'var(--color-long)',
        'long-bg': 'var(--color-long-bg)',
        short: 'var(--color-short)',
        skipped: 'var(--color-skipped)',
        'skipped-bg': 'var(--color-skipped-bg)',
      },
    },
  },
  plugins: [animate],
} satisfies Config
