import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Coins, LogOut, Send, Settings, type LucideIcon } from 'lucide-react'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { ChannelDto } from 'shared/dto.js'
import { apiFetch } from '../lib/api.js'
import { cn } from '../lib/utils.js'

interface NavDef {
  to: string
  label: string
  icon: LucideIcon
}

// Три раздела Ф0 — Actions/Positions пока заглушки (Ф1), но пункты меню и роуты уже есть.
const NAV_ITEMS: NavDef[] = [
  { to: '/channels', label: 'Telegram Channels', icon: Send },
  { to: '/actions', label: 'Actions', icon: Activity },
  { to: '/positions', label: 'Positions', icon: Coins },
]

function isNavActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`)
}

// Layout — сайдбар 246px + топбар 60px + контент (Admin.dc.html:70-478), обёртка для
// всех защищённых роутов (гард RequireAuth — в router.tsx). Ниже 820px сайдбар прячется,
// снизу появляется bottomnav (index.css, медиазапрос max-width:820px).
export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  async function handleLogout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      navigate('/login', { replace: true })
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <aside
        data-m="sidebar"
        className="flex w-sidebar flex-none flex-col border-r border-white/[.07] bg-bg"
      >
        <div className="flex h-topbar items-center gap-[11px] border-b border-white/[.06] px-5">
          <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-accent">
            <div className="h-[11px] w-[11px] rounded-sm bg-black" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-fg">
              CopyTrade AI
            </span>
            <span className="text-[11px] font-medium text-muted-2">Control panel</span>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-[3px] p-3">
          <div className="px-[10px] pb-2 pt-[6px] text-[10.5px] font-semibold uppercase tracking-[.08em] text-muted-3">
            Overview
          </div>
          {NAV_ITEMS.map((item) => (
            <SidebarNavLink key={item.to} item={item} active={isNavActive(location.pathname, item.to)} />
          ))}
        </nav>

        <div className="border-t border-white/[.06] p-3">
          {/* В оригинале эта кнопка тоже без onClick — Settings пока декоративная (Ф1). */}
          <button
            type="button"
            className="flex w-full items-center gap-[11px] rounded-[7px] bg-transparent px-[11px] py-[9px] text-left font-sans text-[13.5px] font-medium text-secondary-3 hover:bg-white/[.04] hover:text-fg"
          >
            <Settings size={16} className="flex-none" />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <header
          data-m="topbar"
          className="flex h-topbar flex-none items-center gap-[14px] border-b border-white/[.07] px-[26px]"
        >
          <Breadcrumbs />
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="ml-auto inline-flex h-[34px] items-center gap-[7px] rounded-[7px] border border-white/10 bg-transparent px-[13px] font-sans text-[12.5px] font-medium text-secondary-2 hover:bg-white/5 hover:text-fg"
          >
            <LogOut size={15} className="flex-none" />
            Logout
          </button>
        </header>

        <main data-m="main" className="flex-1 overflow-y-auto px-[30px] pb-12 pt-7">
          <Outlet />
        </main>
      </div>

      <div
        data-m="bottomnav"
        className="fixed inset-x-0 bottom-0 z-50 hidden justify-around border-t border-white/[.08] bg-bg px-1.5 py-[7px]"
      >
        {NAV_ITEMS.map((item) => (
          <BottomNavLink key={item.to} item={item} active={isNavActive(location.pathname, item.to)} />
        ))}
      </div>
    </div>
  )
}

function SidebarNavLink({ item, active }: { item: NavDef; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-[11px] rounded-[7px] px-[11px] py-[9px] font-sans text-[13.5px]',
        active ? 'bg-white/[.06] font-semibold text-fg' : 'bg-transparent font-medium text-secondary-3',
      )}
    >
      <Icon size={16} className="flex-none" color={active ? '#ff6a1f' : '#6b6b70'} />
      <span>{item.label}</span>
    </Link>
  )
}

function BottomNavLink({ item, active }: { item: NavDef; active: boolean }) {
  const Icon = item.icon
  // label в bottomnav короче, чем в сайдбаре (Admin.dc.html:731-733: 'Channels', не 'Telegram Channels').
  const label = item.to === '/channels' ? 'Channels' : item.label
  return (
    <Link
      to={item.to}
      className="flex flex-1 flex-col items-center gap-1 bg-transparent px-0 py-[6px] font-sans"
    >
      <Icon size={20} className="flex-none" color={active ? '#ff6a1f' : '#6b6b70'} />
      <span className={cn('text-[10px]', active ? 'font-semibold text-accent' : 'font-medium text-muted-1')}>
        {label}
      </span>
    </Link>
  )
}

interface Crumb {
  label: string
  to?: string
}

function Breadcrumbs() {
  const location = useLocation()
  const { id } = useParams()
  const isChannelDetail = /^\/channels\/[^/]+$/.test(location.pathname)

  const { data: channel } = useQuery({
    queryKey: ['channel', id],
    queryFn: () => apiFetch<ChannelDto>(`/channels/${id}`),
    enabled: isChannelDetail && Boolean(id),
  })

  let crumbs: Crumb[]
  if (isChannelDetail) {
    crumbs = [{ label: 'Telegram Channels', to: '/channels' }, { label: channel?.title ?? `#${id}` }]
  } else if (location.pathname.startsWith('/actions')) {
    crumbs = [{ label: 'Actions' }]
  } else if (location.pathname.startsWith('/positions')) {
    crumbs = [{ label: 'Positions' }]
  } else {
    crumbs = [{ label: 'Telegram Channels' }]
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {crumbs.map((c, i) => (
        <span key={c.label} className="flex items-center gap-2">
          {i > 0 ? <span className="text-[13px] text-[#3a3a40]">/</span> : null}
          {c.to ? (
            <Link
              to={c.to}
              className="whitespace-nowrap text-sm font-medium text-secondary-3 hover:text-fg"
            >
              {c.label}
            </Link>
          ) : (
            <span className="whitespace-nowrap text-sm font-semibold text-fg">{c.label}</span>
          )}
        </span>
      ))}
    </div>
  )
}
