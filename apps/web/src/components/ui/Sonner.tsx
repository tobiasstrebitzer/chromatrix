import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * Toast host. Mounted once at the app root; call `toast()` from anywhere.
 *
 * Themed purely through sonner's CSS custom properties pointed at our own tokens, rather than by passing it a
 * `theme` prop. Our tokens already swap on `[data-theme]`, so the toasts re-theme with everything else and
 * there is no second source of truth to keep in sync — which matters here because `lib/theme.ts` flips a DOM
 * attribute and deliberately holds no React state a `theme` prop could read.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position='bottom-right'
      // Colour is information in this design system, so toasts stay neutral by default; the semantic
      // variants below are reserved for states a human should actually react to.
      toastOptions={{
        classNames: {
          toast: 'font-sans text-body-sm',
          description: 'text-fg-3',
          actionButton: 'font-medium',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--bg-surface)',
          '--normal-text': 'var(--fg-1)',
          '--normal-border': 'var(--border-light)',
          '--success-bg': 'var(--success-bg)',
          '--success-text': 'var(--success)',
          '--success-border': 'var(--border-light)',
          '--error-bg': 'var(--danger-bg)',
          '--error-text': 'var(--danger)',
          '--error-border': 'var(--border-light)',
          '--warning-bg': 'var(--warning-bg)',
          '--warning-text': 'var(--warning)',
          '--warning-border': 'var(--border-light)',
          '--border-radius': 'var(--radius-md)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { toast } from 'sonner'
