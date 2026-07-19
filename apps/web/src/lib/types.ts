// Domain shapes the dashboard consumes. The gateway's tRPC procedures currently type their output as
// `unknown` (the controller methods return inferred objects, no response DTO), so we cast to these at the
// call boundary in lib/useGateway.ts. Keep in sync with @chromatrix/core SessionInfo + the gateway's
// AllocatedTab.

export interface SessionInfo {
  identity: string
  profileDir: string
  state: string
  tabs: number
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
}

export interface HealthResult {
  identity: string
  product: string
}
