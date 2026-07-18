import { type FunctionComponent, type HTMLAttributes } from 'react'
import { type VariantProps, cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// Pill badge — semantic state + the reserved `chroma` brand variant. Color is information, never
// decoration: pick the variant that matches the real state. `chroma` (the spectrum gradient) is for
// top-of-surface brand accents only.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label font-medium whitespace-nowrap leading-relaxed',
  {
    variants: {
      variant: {
        neutral: 'border-border-light bg-[var(--bg-code)] text-fg-2',
        accent: 'border-accent/30 bg-accent-bg text-accent',
        success: 'border-success/30 bg-success-bg text-success',
        warning: 'border-warning/30 bg-warning-bg text-warning',
        danger: 'border-danger/30 bg-danger-bg text-danger',
        info: 'border-info/30 bg-info-bg text-info',
        chroma: 'border-transparent text-white',
      },
      mono: { true: 'font-mono', false: '' },
    },
    defaultVariants: { variant: 'neutral', mono: false },
  },
)

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Render a leading status dot in the current color. */
  dot?: boolean
}

export const Badge: FunctionComponent<BadgeProps> = ({ className, variant = 'neutral', mono, dot, children, style, ...props }) => (
  <span
    data-slot='badge'
    className={cn(badgeVariants({ variant, mono, className }))}
    style={variant === 'chroma' ? { background: 'var(--chroma-gradient)', ...style } : style}
    {...props}>
    {dot && <span className='size-1.5 rounded-full bg-current' />}
    {children}
  </span>
)

export { badgeVariants }
