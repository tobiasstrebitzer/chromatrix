import { cn } from '@/lib/utils'
import { Logo } from './Logo'

interface WordmarkProps {
  /** `full` = logo + wordmark; `small` = compact; `mark` = glyph only. */
  size?: 'full' | 'small' | 'mark'
  className?: string
}

/**
 * The logo lockup. `Logo` is the primary brand asset and carries all the motion (shimmer / activity / hover);
 * this only handles the lockup with the wordmark text.
 */
export function Wordmark({ size = 'full', className }: WordmarkProps) {
  if (size === 'mark') return <Logo className={className} />
  return (
    <span className={cn('flex items-center gap-2 text-text', className)}>
      {/* The logo matches the nav icons at 16px rather than out-scaling them - the wordmark is a peer of the
          navigation, not a banner above it. */}
      <Logo size={16} />
      <span className={cn('font-sans font-semibold tracking-tight', size === 'small' ? 'text-body-sm' : 'text-heading-3')}>
        chromatrix
      </span>
    </span>
  )
}
