import * as React from 'react'
import { useSessions } from './useGateway'
import type { SessionInfo } from './types'

// One poller shared by the sidebar (running-session count) and the Sessions view, so we don't double-poll.
interface SessionsCtx {
  sessions: SessionInfo[] | undefined
  error: string | undefined
  refresh: () => Promise<void>
}

const Ctx = React.createContext<SessionsCtx | null>(null)

export function SessionsProvider({ children }: { children: React.ReactNode }) {
  const value = useSessions()
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSessionsContext(): SessionsCtx {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error('useSessionsContext must be used within <SessionsProvider>')
  return ctx
}
