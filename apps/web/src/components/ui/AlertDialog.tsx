import { type ComponentProps, type FunctionComponent } from 'react'
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import { cn } from '@/lib/utils'

// Alert dialog built on base-ui (the same primitive Select.tsx wraps), restyled onto the chromatrix tokens.
//
// Deliberately the *alert* variant rather than the plain Dialog: it has no pointer-dismissal and no escape
// hatch by click-away, so the only ways out are the explicit Cancel and Confirm buttons. That is the correct
// shape for a destructive, irreversible action — a stray click on the backdrop should never be able to
// resolve the question either way.

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger
export const AlertDialogClose = AlertDialogPrimitive.Close

export const AlertDialogContent: FunctionComponent<AlertDialogPrimitive.Popup.Props> = ({
  className,
  ...props
}) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Backdrop className='fixed inset-0 z-60 bg-black/50 backdrop-blur-[1px] transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0' />
    <AlertDialogPrimitive.Popup
      data-slot='alert-dialog-content'
      className={cn(
        'fixed top-1/2 left-1/2 z-60 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
        'rounded-lg border border-border bg-surface p-5 text-fg-1 shadow-(--shadow-lg) outline-none',
        'transition-all data-ending-style:scale-95 data-ending-style:opacity-0',
        'data-starting-style:scale-95 data-starting-style:opacity-0',
        className,
      )}
      {...props}
    />
  </AlertDialogPrimitive.Portal>
)

export const AlertDialogTitle: FunctionComponent<AlertDialogPrimitive.Title.Props> = ({
  className,
  ...props
}) => (
  <AlertDialogPrimitive.Title
    data-slot='alert-dialog-title'
    className={cn('text-body font-semibold text-text', className)}
    {...props}
  />
)

export const AlertDialogDescription: FunctionComponent<AlertDialogPrimitive.Description.Props> = ({
  className,
  ...props
}) => (
  <AlertDialogPrimitive.Description
    data-slot='alert-dialog-description'
    className={cn('mt-1.5 text-body-sm text-muted-foreground', className)}
    {...props}
  />
)

/** The action row. Right-aligned, cancel first — the safe choice sits where the eye lands coming off the text. */
export const AlertDialogFooter: FunctionComponent<ComponentProps<'div'>> = ({ className, ...props }) => (
  <div className={cn('mt-5 flex items-center justify-end gap-2', className)} {...props} />
)
