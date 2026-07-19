import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { SessionsProvider } from './lib/sessionsContext'
import { Toaster } from './components/ui/Sonner'

export function App() {
  return (
    <SessionsProvider>
      <RouterProvider router={router} />
      {/* Outside the router so toasts survive navigation — a confirmation fired by a mutation that also
          navigates must not be unmounted by the route change that follows it. */}
      <Toaster />
    </SessionsProvider>
  )
}
