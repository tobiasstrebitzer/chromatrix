import { type FunctionComponent, type HTMLAttributes } from 'react'
import { type VariantProps, cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// Pill badge. Colour is information, never decoration: pick the variant that matches the real state. On an
// achromatic canvas a coloured badge is loud by construction, so `neutral` is the right default and the
// semantic variants are reserved for things a human should actually react to.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-label font-medium whitespace-nowrap leading-relaxed',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-[var(--bg-code)] text-fg-2',
        accent: 'border-border-strong bg-accent-bg text-fg-1',
        success: 'border-success/25 bg-success-bg text-success',
        warning: 'border-warning/25 bg-warning-bg text-warning',
        danger: 'border-danger/25 bg-danger-bg text-danger',
        info: 'border-info/25 bg-info-bg text-info',
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
  <span data-slot='badge' className={cn(badgeVariants({ variant, mono, className }))} style={style} {...props}>
    {dot && <span className='size-1.5 rounded-full bg-current' />}
    {children}
  </span>
)

export { badgeVariants }
