// Domain shapes the dashboard consumes. The gateway's tRPC procedures currently type their output as
// `unknown` (the controller methods return inferred objects, no response DTO), so we cast to these at the
// call boundary in lib/useGateway.ts. Keep in sync with @chromatrix/core SessionInfo + the gateway's
// AllocatedTab.

/**
 * A session's lifecycle state. `stopped` is a resting state a long-lived session sits in between runs - the
 * identity and its logged-in profile still exist on disk, so it appears in the list and can be started again.
 */
export type SessionState = 'running' | 'starting' | 'stopped'

export interface SessionInfo {
  identity: string
  profileDir: string
  state: SessionState
  tabs: number
  /** Empty unless the session is running. */
  browserWsUrl: string
  /** The tabs this identity currently leases. Server-held, so a page reload re-renders the real list. */
  leases: AllocatedTab[]
}

/** A tab the takeover viewer can attach to, pushed over the takeover socket. */
export interface TargetSummary {
  targetId: string
  url: string
  title: string
  agentId?: string
}

export interface AllocatedTab {
  identity: string
  agentId: string
  targetId: string
  createdAt: string
  /** Scoped, agent-bound raw-CDP endpoint the agent connects to (carries the single-use token). */
  cdpUrl: string
  /** Live page URL, read from CDP per listSessions call. Absent if the target vanished between polls. */
  url?: string
  /** Live page title. Empty string for a page that hasn't set one (e.g. about:blank). */
  title?: string
}

export interface HealthResult {
  identity: string
  product: string
}

/** A tab's content-area size in CSS px. */
export interface Viewport {
  width: number
  height: number
}

export interface GatewaySettings {
  /** Applied to new tabs that don't specify a size. Unset = leave Chrome's default alone. */
  defaultViewport?: Viewport
}

/**
 * Chrome's minimum window size, so the UI can clamp before asking rather than showing the user a number the
 * gateway is about to silently correct. Mirrors MIN_VIEWPORT_* in the gateway service.
 */
export const MIN_VIEWPORT_WIDTH = 500
export const MIN_VIEWPORT_HEIGHT = 288
