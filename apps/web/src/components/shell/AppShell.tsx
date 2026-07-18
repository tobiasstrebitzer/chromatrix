import { Menu, PanelLeftOpen } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/utils'
import { usePersistedState } from '@/lib/usePersistedState'
import { Wordmark } from '../brand/Wordmark'
import { Button } from '../ui/Button'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar, type NavItem } from './Sidebar'
import { TopBar, type TopBarContent } from './TopBar'

interface AppShellProps {
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
  topbar?: TopBarContent
  sidebarFooter?: React.ReactNode
  children: React.ReactNode
}

// App shell: sidebar + canvas on desktop; below md the sidebar collapses to an off-canvas drawer toggled
// from the top bar. Desktop collapse (hide) is persisted, with an expand affordance in the top bar.
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
    <div className='flex h-dvh w-full overflow-hidden bg-bg text-text'>
      {/* Desktop sidebar (collapsible) */}
      <aside className={cn('shrink-0', collapsed ? 'hidden' : 'hidden md:block')}>
        <Sidebar items={items} activeId={activeId} onSelect={select} onCollapse={() => setCollapsed(true)} footer={sidebarFooter} />
      </aside>

      {/* Mobile off-canvas drawer */}
      {drawerOpen && (
        <div className='fixed inset-0 z-40 md:hidden'>
          <button type='button' aria-label='Close menu' className='absolute inset-0 bg-text/30' onClick={() => setDrawerOpen(false)} />
          <div className='absolute inset-y-0 left-0 shadow-(--shadow-md)'>
            <Sidebar items={items} activeId={activeId} onSelect={select} footer={sidebarFooter} />
          </div>
        </div>
      )}

      {/* Main canvas */}
      <div className='flex min-w-0 flex-1 flex-col'>
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
              {collapsed && (
                <span className='hidden items-center gap-1 md:inline-flex'>
                  <Button variant='ghost' size='icon' aria-label='Expand sidebar' title='Expand sidebar' onClick={() => setCollapsed(false)}>
                    <PanelLeftOpen />
                  </Button>
                  <a href='#/' className='flex rounded-md' aria-label='chromatrix home'>
                    <Wordmark size='small' />
                  </a>
                </span>
              )}
            </>
          }
          trailing={<ThemeToggle />}
        />
        <main className='min-h-0 flex-1 overflow-y-auto'>{children}</main>
      </div>
    </div>
  )
}
