import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react'
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

/**
 * The header row's top offset. The sidebar sits on the canvas *outside* the inset frame, so to make the
 * wordmark optically centre on the framed top bar it has to drop by the frame's top margin (8px) plus its
 * 1px border. Shared by both the full sidebar and the rail so they don't drift apart.
 */
const HEADER_OFFSET = 'mt-[9px]'

// Flat nav sidebar: wordmark, a vertical list of the top-level views (active view carries the accent
// left-bar + tint), and a meta footer. Sits directly on the app canvas — no border, no surface of its own.
export function Sidebar({ items, activeId, onSelect, onCollapse, footer, className }: SidebarProps) {
  return (
    <nav className={cn('flex h-full w-[248px] flex-col bg-sidebar', className)} aria-label='Views'>
      <div className={cn('flex h-14 items-center gap-1 px-3', HEADER_OFFSET)}>
        {/* pl-1.5 puts the mark on the same 18px optical line as the nav icons below (header px-3 = 12,
            nav px-2 + item px-2.5 = 18). */}
        <a href='#/' className='mr-auto flex items-center rounded-md pl-1.5' aria-label='chromatrix home'>
          <Wordmark size='full' />
        </a>
        {onCollapse && (
          <Button variant='ghost' size='icon-sm' onClick={onCollapse} aria-label='Collapse sidebar' title='Collapse sidebar'>
            <PanelLeftClose />
          </Button>
        )}
      </div>

      {/* No top padding: the first nav item sits directly under the wordmark row, so the nav reads as one
          column rather than as a block floating below the header. */}
      <div className='flex-1 space-y-0.5 overflow-y-auto px-2 pb-2'>
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

/**
 * The collapsed sidebar: an icon-only rail. Same nav, same order, labels dropped to `title`/`aria-label`.
 *
 * A hard swap with the full sidebar rather than an animated width: the label text has nowhere to go at 48px,
 * so a width transition just reflows and clips it mid-flight. Swapping reads as deliberate; sliding reads as
 * broken.
 */
export function SidebarRail({
  items,
  activeId,
  onSelect,
  onExpand,
}: {
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
  onExpand: () => void
}) {
  return (
    <nav className='flex h-full w-12 flex-col items-center bg-sidebar' aria-label='Views'>
      <div className={cn('flex h-14 items-center', HEADER_OFFSET)}>
        <a href='#/' className='flex rounded-md' aria-label='chromatrix home'>
          <Wordmark size='mark' />
        </a>
      </div>

      <div className='flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2'>
        {items.map((item) => {
          const Icon = item.icon
          const active = item.id === activeId
          return (
            <button
              key={item.id}
              type='button'
              onClick={() => onSelect(item.id)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              title={item.label}
              className={cn(
                'flex size-9 items-center justify-center rounded-md',
                'transition-colors duration-[120ms] ease-[var(--ease-standard)] hover:bg-accent-tint hover:text-text',
                active ? 'bg-accent-tint text-accent' : 'text-muted-foreground',
              )}>
              <Icon className='size-4' />
            </button>
          )
        })}
      </div>

      <div className='py-3'>
        <Button variant='ghost' size='icon' onClick={onExpand} aria-label='Expand sidebar' title='Expand sidebar'>
          <PanelLeftOpen />
        </Button>
      </div>
    </nav>
  )
}
