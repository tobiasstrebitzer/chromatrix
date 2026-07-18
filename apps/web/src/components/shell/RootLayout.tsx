import { Boxes, MonitorPlay } from 'lucide-react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useSessionsContext } from '@/lib/sessionsContext'
import { AppShell } from './AppShell'
import type { NavItem } from './Sidebar'

const NAV: (NavItem & { path: string })[] = [
  { id: 'sessions', label: 'Sessions', icon: Boxes, path: '/sessions' },
  { id: 'takeover', label: 'Takeover', icon: MonitorPlay, path: '/takeover' },
]

// The app shell wrapper: derives the active view from the URL, threads the running-session count into the
// nav, and renders the matched route through <Outlet/>.
export function RootLayout() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { sessions } = useSessionsContext()

  const activeId = pathname.startsWith('/takeover') ? 'takeover' : 'sessions'
  const items = NAV.map((n) => (n.id === 'sessions' ? { ...n, count: sessions?.length } : n))
  const activeLabel = NAV.find((n) => n.id === activeId)?.label ?? 'chromatrix'

  return (
    <AppShell
      items={items}
      activeId={activeId}
      onSelect={(id) => {
        const target = NAV.find((n) => n.id === id)
        if (target) void navigate({ to: target.path })
      }}
      topbar={{ crumbs: [{ label: activeLabel }] }}
      sidebarFooter={
        <div className='flex items-center gap-2 text-label text-muted-foreground'>
          <span className='size-1.5 rounded-full' style={{ background: 'var(--chroma-gradient)' }} />
          <span className='truncate font-mono'>{sessions ? `${sessions.length} running` : 'connecting…'}</span>
        </div>
      }>
      <Outlet />
    </AppShell>
  )
}
