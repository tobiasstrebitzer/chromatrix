// Orchestrator — the domain facade the gateway drives (PRD §4). Holds the identity registry and, per running
// identity, a ChromeSupervisor (the process + control channel) paired with a TabPool (exclusive tab leasing).
// It knows nothing about HTTP/WS/CDP-mux — the gateway layers those on top. One Chrome per identity, shared
// default context, exclusive per-agent tabs: the v1 concurrency model S3 validated.

import { CdpClient } from '@chromatrix/cdp'
import { IdentityRegistry, type Identity } from './identity.ts'
import { ChromeSupervisor, type SupervisorOptions } from './supervisor.ts'
import { TabPool, type Lease, type TabPoolOptions } from './tab-pool.ts'

export interface Session {
  readonly supervisor: ChromeSupervisor
  readonly tabs: TabPool
}

export interface SessionInfo {
  identity: string
  profileDir: string
  state: string
  tabs: number
  browserWsUrl: string
}

export interface OrchestratorOptions extends SupervisorOptions, TabPoolOptions {}

export class Orchestrator {
  private readonly sessions = new Map<string, Session>()

  constructor(
    readonly registry: IdentityRegistry,
    private readonly options: OrchestratorOptions = {},
  ) {}

  /** Register an identity's profile dir (creates it if absent). Does not launch Chrome. */
  createIdentity(id: string): Identity {
    return this.registry.create(id)
  }

  /** Whether an identity currently has a running Chrome. */
  isRunning(id: string): boolean {
    return this.sessions.get(id)?.supervisor.status === 'running'
  }

  /** Start (or return the already-running) session for an identity: launches Chrome + control channel. */
  async startIdentity(id: string): Promise<Session> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const identity = this.registry.create(id)
    const supervisor = new ChromeSupervisor(identity, this.options)
    await supervisor.start()
    const tabs = new TabPool(id, supervisor.client, this.options)
    const session = { supervisor, tabs }
    this.sessions.set(id, session)
    return session
  }

  private require(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`identity "${id}" is not running — start it first`)
    return s
  }

  /** Lease an exclusive tab under a running identity for `agentId`. */
  async allocateTab(id: string, agentId: string, opts: { url?: string } = {}): Promise<Lease> {
    return this.require(id).tabs.lease(agentId, opts)
  }

  async releaseTab(id: string, targetId: string): Promise<void> {
    await this.require(id).tabs.release(targetId)
  }

  /** Control CDP client for a running identity (browser endpoint) — e.g. for takeover/screencast. */
  client(id: string): CdpClient {
    return this.require(id).supervisor.client
  }

  session(id: string): Session {
    return this.require(id)
  }

  async health(id: string): Promise<string> {
    return this.require(id).supervisor.health()
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.entries()].map(([id, s]) => ({
      identity: id,
      profileDir: s.supervisor.identity.profileDir,
      state: s.supervisor.status,
      tabs: s.tabs.size,
      browserWsUrl: safe(() => s.supervisor.browserWsUrl) ?? '',
    }))
  }

  async stopIdentity(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    await s.tabs.releaseAll().catch(() => {})
    await s.supervisor.stop()
  }

  /** Stop every running identity (graceful shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stopIdentity(id)))
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
