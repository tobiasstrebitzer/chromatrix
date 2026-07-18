import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { SessionsProvider } from './lib/sessionsContext'

export function App() {
  return (
    <SessionsProvider>
      <RouterProvider router={router} />
    </SessionsProvider>
  )
}
