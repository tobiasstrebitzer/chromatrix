import * as React from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { SessionsProvider } from './lib/sessionsContext'
import { Toaster } from './components/ui/Sonner'
import { LoginView } from './views/LoginView'
import { isAuthenticated, onAuthExpired } from './lib/auth'

/**
 * Auth gate. The whole app is behind it - including SessionsProvider, whose poll would otherwise hammer a
 * gateway that has already said no.
 *
 * Three states, and the third matters: `undefined` (still asking) renders nothing rather than flashing the
 * login screen. `/api/auth/status` is a same-origin round trip, so guessing "logged out" for a frame means
 * every reload of an authenticated session blinks a sign-in form.
 */
export function App() {
  const [authed, setAuthed] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    void isAuthenticated().then(setAuthed)
    // The cookie can stop being valid while the app is open - signed out in another tab, or the token rotated
    // and the gateway restarted. Without this the app would poll 401s forever and just look broken.
    return onAuthExpired(() => setAuthed(false))
  }, [])

  if (authed === undefined) return null
  if (!authed) return <LoginView onAuthenticated={() => setAuthed(true)} />

  return (
    <SessionsProvider>
      <RouterProvider router={router} />
      {/* Outside the router so toasts survive navigation - a confirmation fired by a mutation that also
          navigates must not be unmounted by the route change that follows it. */}
      <Toaster />
    </SessionsProvider>
  )
}
