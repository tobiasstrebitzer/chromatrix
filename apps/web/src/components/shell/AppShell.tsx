import { Menu } from 'lucide-react'
import * as React from 'react'
import { usePersistedState } from '@/lib/usePersistedState'
import { Wordmark } from '../brand/Wordmark'
import { Button } from '../ui/Button'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar, SidebarRail, type NavItem } from './Sidebar'
import { TopBar, type TopBarContent } from './TopBar'

interface AppShellProps {
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
  topbar?: TopBarContent
  sidebarFooter?: React.ReactNode
  children: React.ReactNode
}

/**
 * Inset ("framed") app shell: the nav sits directly on the app canvas, while the top bar + content live in a
 * rounded, bordered panel inset with a margin all around.
 *
 * The canvas and the panel are deliberately different surfaces, and their polarity flips by theme - in light
 * the panel is the bright sheet on grey, in dark it is a darker well with the rail raised around it. That
 * contrast is the whole effect, so the panel takes its fill from `.frame-shine` and must not be given a
 * `bg-*` utility (see globals.css).
 *
 * Collapsing swaps the sidebar for an icon rail rather than hiding it, so navigation is always reachable.
 */
export function AppShell({ items, activeId, onSelect, topbar, sidebarFooter, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [collapsed, setCollapsed] = usePersistedState('chromatrix.sidebar.collapsed', false, (v) => typeof v === 'boolean')

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const select = (id: string) => {
    onSelect(id)
    setDrawerOpen(false)
  }

  return (
    <div className='flex h-dvh w-full overflow-hidden bg-sidebar text-text'>
      {/* Desktop nav: full sidebar, or an icon-only rail while collapsed */}
      <aside className='hidden shrink-0 md:block'>
        {collapsed ? (
          <SidebarRail items={items} activeId={activeId} onSelect={select} onExpand={() => setCollapsed(false)} />
        ) : (
          <Sidebar items={items} activeId={activeId} onSelect={select} onCollapse={() => setCollapsed(true)} footer={sidebarFooter} />
        )}
      </aside>

      {/* Mobile off-canvas drawer */}
      {drawerOpen && (
        <div className='fixed inset-0 z-40 md:hidden'>
          <button type='button' aria-label='Close menu' className='absolute inset-0 bg-text/30' onClick={() => setDrawerOpen(false)} />
          <div className='absolute inset-y-0 left-0 shadow-(--shadow-md)'>
            {/* The drawer floats over a scrim rather than sitting on the canvas, so unlike the desktop
                sidebar it needs an edge of its own. */}
            <Sidebar className='border-r border-border' items={items} activeId={activeId} onSelect={select} footer={sidebarFooter} />
          </div>
        </div>
      )}

      {/* The inset frame. `md:pl-0` so the panel hugs the rail with a single gutter, not a double one. */}
      <div className='flex min-w-0 flex-1 flex-col p-2 md:pl-0'>
        <div className='frame-shine flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl'>
          <TopBar
            content={topbar}
            leading={
              <>
                <Button variant='ghost' size='icon' className='md:hidden' aria-label='Open menu' onClick={() => setDrawerOpen(true)}>
                  <Menu />
                </Button>
                <span className='md:hidden'>
                  <Wordmark size='small' />
                </span>
              </>
            }
            trailing={<ThemeToggle />}
          />
          <main className='min-h-0 flex-1 overflow-y-auto'>{children}</main>
        </div>
      </div>
    </div>
  )
}
