import * as React from 'react'
import { trackActivity } from './activity'
import { trpc } from './trpc'
import type { AllocatedTab, GatewaySettings, HealthResult, SessionInfo, Viewport } from './types'

/**
 * Typed façade over the gateway's tRPC procedures (named `gateway<Method>` by the silkweave adapter). The
 * procedures type their output as `unknown`, so the casts here are the single place that pins the shapes to
 * lib/types.ts.
 *
 * Every call a *user* initiated is wrapped in `trackActivity`, which drives the logo's activity mode.
 * `listSessions` deliberately is not: it polls every 2.5s, so counting it would pin the logo to "busy"
 * forever and the signal would stop meaning anything.
 */
export const gateway = {
  listSessions: () => trpc.gatewayListSessions.query({}) as Promise<{ sessions: SessionInfo[] }>,
  createIdentity: (id: string) => trackActivity(trpc.gatewayCreateIdentity.mutate({ id })),
  startIdentity: (id: string, headless?: boolean) =>
    trackActivity(trpc.gatewayStartIdentity.mutate({ id, headless })) as Promise<SessionInfo>,
  stopIdentity: (id: string) => trackActivity(trpc.gatewayStopIdentity.mutate({ id })),
  /** Irreversible: stops Chrome and deletes the profile dir (the signed-in session goes with it). */
  deleteIdentity: (id: string) => trackActivity(trpc.gatewayDeleteIdentity.mutate({ id })),
  allocateTab: (identity: string, agentId: string, url?: string, viewport?: Viewport) =>
    trackActivity(
      trpc.gatewayAllocateTab.mutate({
        identity,
        agentId,
        url,
        width: viewport?.width,
        height: viewport?.height,
      }),
    ) as Promise<AllocatedTab>,
  navigateTab: (identity: string, targetId: string, url: string) =>
    trackActivity(trpc.gatewayNavigateTab.mutate({ identity, targetId, url })) as Promise<{ url: string }>,
  getTabViewport: (identity: string, targetId: string) =>
    trackActivity(trpc.gatewayGetTabViewport.mutate({ identity, targetId })) as Promise<Viewport>,
  setTabViewport: (identity: string, targetId: string, width: number, height: number) =>
    trackActivity(trpc.gatewaySetTabViewport.mutate({ identity, targetId, width, height })) as Promise<Viewport>,
  getSettings: () => trackActivity(trpc.gatewayGetSettings.query({})) as Promise<GatewaySettings>,
  /** 0×0 clears the default — matches the gateway's sentinel (MCP inputs can't be nullable). */
  setDefaultViewport: (width: number, height: number) =>
    trackActivity(trpc.gatewaySetDefaultViewport.mutate({ width, height })) as Promise<GatewaySettings>,
  releaseTab: (identity: string, targetId: string) =>
    trackActivity(trpc.gatewayReleaseTab.mutate({ identity, targetId })),
  health: (identity: string) => trackActivity(trpc.gatewayHealth.mutate({ identity })) as Promise<HealthResult>,
  startTakeover: (identity: string) =>
    trackActivity(trpc.gatewayStartTakeover.mutate({ identity })) as Promise<{ identity: string; viewerUrl: string }>,
}

/**
 * URL of a one-off JPEG of a tab. Not a tRPC procedure: it answers with image bytes, so the efficient client
 * is an `<img src>` — the browser handles fetch, decode and eviction, and nothing lands in JS memory.
 *
 * `cacheBust` is required rather than optional because the response is `Cache-Control: no-store` but an
 * `<img>` whose `src` string doesn't change is never re-requested at all — the caller must pass a value that
 * moves (a poll tick) or the thumbnail silently freezes on its first frame.
 */
export function tabScreenshotUrl(identity: string, targetId: string, cacheBust: number): string {
  const q = new URLSearchParams({ identity, targetId, t: String(cacheBust) })
  return `/api/tab/screenshot?${q}`
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
