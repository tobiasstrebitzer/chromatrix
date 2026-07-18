import { type InputHTMLAttributes, forwardRef } from 'react'
import { cn } from '@/lib/utils'

// Text input styled to the chromatrix tokens: hairline border, accent focus ring, mono-friendly.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      data-slot='input'
      className={cn(
        'h-9 w-full rounded-md border border-border bg-background px-2.5 text-body-sm text-text',
        'placeholder:text-fg-4 transition-colors outline-none',
        'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
