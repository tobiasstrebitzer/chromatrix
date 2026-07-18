import { useId } from 'react'
import { cn } from '@/lib/utils'

interface MarkProps {
  size?: number
  className?: string
  title?: string
}

/** chromatrix brand mark — a 3×3 dot matrix over the chroma spectrum ("colour matrix"). */
export function Mark({ size = 24, className, title = 'chromatrix' }: MarkProps) {
  const id = useId()
  const dots = [6, 12, 18].flatMap((y) => [6, 12, 18].map((x) => ({ x, y })))
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      role='img'
      aria-label={title}
      className={cn('shrink-0 select-none', className)}
      xmlns='http://www.w3.org/2000/svg'>
      <rect width='24' height='24' rx='6' fill={`url(#${id})`} />
      <g fill='#ffffff' fillOpacity='0.92'>
        {dots.map((d) => (
          <circle key={`${d.x}-${d.y}`} cx={d.x} cy={d.y} r='1.6' />
        ))}
      </g>
      <defs>
        <linearGradient id={id} x1='0' y1='0' x2='24' y2='24' gradientUnits='userSpaceOnUse'>
          <stop stopColor='#f43f5e' />
          <stop offset='0.28' stopColor='#d946ef' />
          <stop offset='0.52' stopColor='#6366f1' />
          <stop offset='0.76' stopColor='#06b6d4' />
          <stop offset='1' stopColor='#10b981' />
        </linearGradient>
      </defs>
    </svg>
  )
}

interface WordmarkProps {
  /** `full` = mark + wordmark; `small` = compact; `mark` = glyph only. */
  size?: 'full' | 'small' | 'mark'
  className?: string
}

export function Wordmark({ size = 'full', className }: WordmarkProps) {
  if (size === 'mark') return <Mark className={className} />
  const markSize = size === 'small' ? 20 : 24
  return (
    <span className={cn('flex items-center gap-2 text-text', className)}>
      <Mark size={markSize} />
      <span className={cn('font-sans font-semibold tracking-tight', size === 'small' ? 'text-body' : 'text-heading-3')}>
        chromatrix
      </span>
    </span>
  )
}
