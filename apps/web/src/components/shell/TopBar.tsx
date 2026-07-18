import { type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

export interface Crumb {
  label: string
  onClick?: () => void
}

export interface TopBarContent {
  crumbs: Crumb[]
  actions?: ReactNode
}

// Single top bar: breadcrumbs on the left, view actions on the right; app-chrome (mobile menu, theme
// toggle) injected via leading/trailing.
export function TopBar({ content, leading, trailing }: { content?: TopBarContent; leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <header className='border-b border-border bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75'>
      <div className='flex h-14 items-center gap-2 px-4'>
        {leading}
        {content && <Breadcrumbs crumbs={content.crumbs} />}
        <div className='min-w-0 flex-1' />
        {content?.actions && <div className='flex items-center gap-1.5'>{content.actions}</div>}
        {trailing}
      </div>
    </header>
  )
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label='Breadcrumb' className='flex min-w-0 items-center gap-1.5 text-body-sm'>
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={`${crumb.label}-${i}`} className='flex min-w-0 items-center gap-1.5'>
            {i > 0 && <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />}
            {last ? (
              <span className='truncate font-medium text-text' aria-current='page'>
                {crumb.label}
              </span>
            ) : crumb.onClick ? (
              <button type='button' onClick={crumb.onClick} className='shrink-0 text-muted-foreground transition-colors hover:text-text'>
                {crumb.label}
              </button>
            ) : (
              <span className='shrink-0 text-muted-foreground'>{crumb.label}</span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
