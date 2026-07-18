import * as React from 'react'
import { trpc } from './trpc'
import type { AllocatedTab, HealthResult, SessionInfo } from './types'

// Typed façade over the gateway's tRPC procedures (named `gateway<Method>` by the silkweave adapter). The
// procedures type their output as `unknown`, so the casts here are the single place that pins the shapes to
// lib/types.ts.
export const gateway = {
  listSessions: () => trpc.gatewayListSessions.query({}) as Promise<{ sessions: SessionInfo[] }>,
  createIdentity: (id: string) => trpc.gatewayCreateIdentity.mutate({ id }),
  startIdentity: (id: string, headless?: boolean) =>
    trpc.gatewayStartIdentity.mutate({ id, headless }) as Promise<SessionInfo>,
  stopIdentity: (id: string) => trpc.gatewayStopIdentity.mutate({ id }),
  allocateTab: (identity: string, agentId: string, url?: string) =>
    trpc.gatewayAllocateTab.mutate({ identity, agentId, url }) as Promise<AllocatedTab>,
  releaseTab: (identity: string, targetId: string) => trpc.gatewayReleaseTab.mutate({ identity, targetId }),
  health: (identity: string) => trpc.gatewayHealth.mutate({ identity }) as Promise<HealthResult>,
  startTakeover: (identity: string) =>
    trpc.gatewayStartTakeover.mutate({ identity }) as Promise<{ identity: string; viewerUrl: string }>,
}

/** Poll the running sessions on an interval (the gateway has no push channel today). */
export function useSessions(pollMs = 2500): {
  sessions: SessionInfo[] | undefined
  error: string | undefined
  refresh: () => Promise<void>
} {
  const [sessions, setSessions] = React.useState<SessionInfo[] | undefined>(undefined)
  const [error, setError] = React.useState<string | undefined>(undefined)

  const refresh = React.useCallback(async () => {
    try {
      const r = await gateway.listSessions()
      setSessions(r.sessions)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  React.useEffect(() => {
    let alive = true
    const tick = () => {
      if (alive) void refresh()
    }
    tick()
    const t = setInterval(tick, pollMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [refresh, pollMs])

  return { sessions, error, refresh }
}
