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
