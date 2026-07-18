import { PanelLeftClose, type LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Wordmark } from '../brand/Wordmark'
import { Button } from '../ui/Button'

export interface NavItem {
  id: string
  label: string
  icon: LucideIcon
  /** Optional right-aligned count (e.g. running sessions). */
  count?: number
}

interface SidebarProps {
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
  /** Collapse the sidebar (desktop); omitted in the mobile drawer. */
  onCollapse?: () => void
  footer?: ReactNode
  className?: string
}

// Flat nav sidebar: wordmark, a vertical list of the top-level views (active view carries the accent
// left-bar + tint), and a meta footer.
export function Sidebar({ items, activeId, onSelect, onCollapse, footer, className }: SidebarProps) {
  return (
    <nav className={cn('flex h-full w-[248px] flex-col border-r border-border bg-sidebar', className)} aria-label='Views'>
      <div className='flex h-14 items-center gap-1 px-3'>
        <a href='#/' className='mr-auto flex items-center rounded-md' aria-label='chromatrix home'>
          <Wordmark size='full' />
        </a>
        {onCollapse && (
          <Button variant='ghost' size='icon-sm' onClick={onCollapse} aria-label='Collapse sidebar' title='Collapse sidebar'>
            <PanelLeftClose />
          </Button>
        )}
      </div>

      <div className='flex-1 space-y-0.5 overflow-y-auto px-2 py-2'>
        {items.map((item) => {
          const Icon = item.icon
          const active = item.id === activeId
          return (
            <button
              key={item.id}
              type='button'
              onClick={() => onSelect(item.id)}
              className={cn(
                'group/nav relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body-sm text-text',
                'transition-colors duration-[120ms] ease-[var(--ease-standard)] hover:bg-accent-tint',
                active && 'bg-accent-tint font-medium',
              )}>
              {active && <span className='absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent' />}
              <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-muted-foreground')} />
              <span className='line-clamp-1 flex-1'>{item.label}</span>
              {item.count !== undefined && (
                <span className='shrink-0 font-mono text-label text-muted-foreground tabular-nums'>{item.count}</span>
              )}
            </button>
          )
        })}
      </div>

      {footer && <div className='border-t border-border px-3 py-2.5'>{footer}</div>}
    </nav>
  )
}
