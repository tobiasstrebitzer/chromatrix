import { Boxes, MonitorPlay, Settings } from 'lucide-react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useSessionsContext } from '@/lib/sessionsContext'
import { cn } from '@/lib/utils'
import { AppShell } from './AppShell'
import type { NavItem } from './Sidebar'

const NAV: (NavItem & { path: string })[] = [
  { id: 'sessions', label: 'Sessions', icon: Boxes, path: '/sessions' },
  { id: 'takeover', label: 'Takeover', icon: MonitorPlay, path: '/takeover' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
]

// The app shell wrapper: derives the active view from the URL, threads the running-session count into the
// nav, and renders the matched route through <Outlet/>.
export function RootLayout() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { sessions } = useSessionsContext()

  // Longest matching prefix rather than a chain of ternaries, so adding a nav entry is a one-line change and
  // an unmatched path can't silently highlight the wrong tab.
  const activeId =
    [...NAV].sort((a, b) => b.path.length - a.path.length).find((n) => pathname.startsWith(n.path))?.id ??
    'sessions'
  // Counted, not `sessions.length`: the list now includes stopped sessions too, so the total would overstate
  // how much is actually live. The nav badge and the footer both mean "running right now".
  const running = sessions?.filter((s) => s.state === 'running').length
  const items = NAV.map((n) => (n.id === 'sessions' ? { ...n, count: running } : n))
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
        // The footer dot reports the gateway link, not the brand: green once a poll has landed, amber while
        // we're still waiting for the first one.
        <div className='flex items-center gap-2 text-label text-muted-foreground'>
          <span className={cn('size-1.5 shrink-0 rounded-full', sessions ? 'bg-success' : 'bg-warning')} />
          <span className='truncate font-mono'>{sessions ? `${running} running` : 'connecting…'}</span>
        </div>
      }>
      <Outlet />
    </AppShell>
  )
}
