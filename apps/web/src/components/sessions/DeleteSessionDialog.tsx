import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/AlertDialog'

export interface DeleteSessionDialogProps {
  identity: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called only once the typed id matches. Deleting is irreversible. */
  onConfirm: () => void
}

/**
 * Type-the-id confirmation for deleting a session.
 *
 * The friction is proportionate to what's being destroyed: a session's profile dir holds a *real signed-in
 * browser* — cookies, tokens, whatever a human logged into over takeover — and there is no undo and no
 * backup. Re-typing the identity forces the user to read which one they picked, which is the failure this
 * guards against (deleting the wrong row), rather than the one a plain OK/Cancel guards against (a stray
 * click). The confirm button stays disabled until the text matches exactly.
 */
export function DeleteSessionDialog({ identity, open, onOpenChange, onConfirm }: DeleteSessionDialogProps) {
  const [typed, setTyped] = React.useState('')
  const matches = typed === identity

  // Reset on every open, so a previous half-typed attempt can't pre-arm the button for the next session.
  React.useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const confirm = () => {
    if (!matches) return
    onOpenChange(false)
    onConfirm()
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete session</AlertDialogTitle>
        <AlertDialogDescription>
          This stops Chrome and permanently deletes the profile directory for{' '}
          <span className='font-mono text-fg-1'>{identity}</span>, including its cookies and signed-in state.
          This cannot be undone.
        </AlertDialogDescription>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            confirm()
          }}>
          <label className='mt-4 block text-body-sm text-fg-2' htmlFor={`confirm-${identity}`}>
            Type <span className='font-mono text-fg-1'>{identity}</span> to confirm
          </label>
          <Input
            id={`confirm-${identity}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={identity}
            className='mt-1.5 w-full font-mono'
            autoComplete='off'
            autoFocus
          />

          <AlertDialogFooter>
            <Button variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {/* Filled danger rather than the ghost `destructive` variant: this is the committing action, and it
                should not look like the row-level icon buttons that merely stop a session.
                `text-bg` rather than a fixed white: --danger is a light red in dark theme (#ff6166) and a dark
                one in light theme (#d93036), so a hardcoded foreground fails contrast in one of them. The
                canvas colour inverts alongside it and stays legible in both. */}
            <Button
              type='submit'
              disabled={!matches}
              className='bg-danger text-bg hover:bg-danger/90 focus-visible:ring-danger/60'>
              <Trash2 />
              Delete session
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
