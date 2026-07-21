import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * "This tab has never navigated." Shared by the Sessions tab cards and the Takeover viewer so the same state
 * doesn't get two different treatments - a blank tab looks identical wherever you meet it.
 */
export function BlankTab({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  return (
    <div className={cn('grid place-items-center bg-[var(--bg-code)]', className)}>
      <div className='text-center'>
        <Globe className={cn('mx-auto text-fg-4', size === 'sm' ? 'mb-1.5 size-5' : 'mb-3 size-8')} />
        <p className={cn('font-medium text-fg-3', size === 'sm' ? 'text-body-sm' : 'text-body')}>No URL loaded</p>
        <p className='mt-0.5 text-label text-fg-4'>inactive</p>
      </div>
    </div>
  )
}
