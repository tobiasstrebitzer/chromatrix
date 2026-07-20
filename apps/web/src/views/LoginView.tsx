import * as React from 'react'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { login } from '@/lib/auth'

/**
 * The sign-in gate. One field, because the gateway has exactly one credential.
 *
 * Deliberately not a route: it replaces the whole app rather than rendering inside the shell. A half-rendered
 * dashboard behind a login form would poll `listSessions` on a loop and paint 401s across every card.
 *
 * The failure message stays in-page rather than becoming a toast — a wrong token is something you correct
 * while looking at the field, so it needs to still be there while you fix it.
 */
export function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = React.useState('')
  const [error, setError] = React.useState<string>()
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(undefined)
    const failure = await login(token.trim())
    setBusy(false)
    if (failure) {
      setError(failure)
      return
    }
    setToken('') // don't leave the credential sitting in component state after it's been exchanged
    onAuthenticated()
  }

  return (
    <div className='flex min-h-svh items-center justify-center bg-sidebar p-6'>
      <div className='w-full max-w-sm'>
        <div className='mb-7 flex flex-col items-center gap-3'>
          <Logo size={32} />
          <div className='text-center'>
            <h1 className='text-heading-3 font-semibold tracking-tight text-text'>chromatrix</h1>
            <p className='mt-1 text-body-sm text-muted-foreground'>Sign in with your gateway access token.</p>
          </div>
        </div>

        <form onSubmit={submit} className='frame-shine rounded-xl p-5'>
          <label htmlFor='access-token' className='mb-1.5 block text-body-sm font-medium text-text'>
            Access token
          </label>
          <Input
            id='access-token'
            // `password`, not `text`: this is a live credential and the dashboard is the thing most likely to
            // be on screen while someone else is looking at it.
            type='password'
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder='paste your token'
            autoFocus
            autoComplete='current-password'
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'access-token-error' : 'access-token-hint'}
            className='font-mono'
          />

          {error ? (
            <p id='access-token-error' role='alert' className='mt-2 text-body-sm text-danger'>
              {error}
            </p>
          ) : (
            <p id='access-token-hint' className='mt-2 text-body-sm text-muted-foreground'>
              Printed once on the gateway's first run, and stored in{' '}
              <code className='font-mono text-fg-2'>~/.config/chromatrix/config.json</code>.
            </p>
          )}

          <Button type='submit' size='lg' disabled={!token.trim() || busy} className='mt-4 w-full'>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
