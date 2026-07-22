// Orchestrator - the domain facade the gateway drives. Holds the identity registry and, per running
// identity, a ChromeSupervisor (the process + control channel) paired with a TabPool (exclusive tab leasing).
// It knows nothing about HTTP/WS/CDP-mux - the gateway layers those on top. One Chrome per identity, shared
// default context, exclusive per-agent tabs: the v1 concurrency model S3 validated.

import { CdpClient } from '@chromatrix/cdp'
import { IdentityRegistry, type Identity } from './identity.ts'
import { ChromeSupervisor, type SupervisorOptions, type SupervisorState } from './supervisor.ts'
import { TabPool, type Lease, type TabPoolOptions } from './tab-pool.ts'

export interface Session {
  readonly supervisor: ChromeSupervisor
  readonly tabs: TabPool
}

export interface SessionInfo {
  identity: string
  profileDir: string
  /** `stopped` is a resting state, not an absence - the identity still exists on disk with its session intact. */
  state: SupervisorState
  tabs: number
  /** Empty unless the identity is running. */
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

  /**
   * Start a session for an identity: launches Chrome + control channel. Rejects if the identity is already
   * running - silently returning the existing session would let a caller's `opts` (e.g. `headless`) be
   * ignored with no signal that nothing changed. Call `stopIdentity` first to relaunch with different flags.
   */
  async startIdentity(id: string, opts: SupervisorOptions = {}): Promise<Session> {
    if (this.sessions.has(id)) {
      throw new Error(`identity "${id}" is already running - stop it first to relaunch with different flags`)
    }
    const identity = this.registry.create(id)
    const supervisor = new ChromeSupervisor(identity, { ...this.options, ...opts })
    await supervisor.start()
    const tabs = new TabPool(id, supervisor.client, this.options)
    const session = { supervisor, tabs }
    this.sessions.set(id, session)
    return session
  }

  private require(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`identity "${id}" is not running - start it first`)
    return s
  }

  /** Lease an exclusive tab under a running identity for `agentId`. */
  async allocateTab(id: string, agentId: string, opts: { url?: string; compat?: boolean } = {}): Promise<Lease> {
    return this.require(id).tabs.lease(agentId, opts)
  }

  async releaseTab(id: string, targetId: string): Promise<void> {
    await this.require(id).tabs.release(targetId)
  }

  /** Control CDP client for a running identity (browser endpoint) - e.g. for takeover/screencast. */
  client(id: string): CdpClient {
    return this.require(id).supervisor.client
  }

  session(id: string): Session {
    return this.require(id)
  }

  async health(id: string): Promise<string> {
    return this.require(id).supervisor.health()
  }

  /**
   * Every identity that exists on disk, running or not, annotated with its live state.
   *
   * Enumerating the registry rather than the in-memory session map is what makes a session a *long-lived*
   * thing you start and stop. Listing only the map (as this used to) meant stopping an identity erased it from
   * the UI while its profile - and its logged-in cookies - sat on disk, so "stop" was indistinguishable from
   * "delete" and the durable state was unreachable.
   */
  listSessions(): SessionInfo[] {
    return this.registry.list().map((identity) => {
      const s = this.sessions.get(identity.id)
      return {
        identity: identity.id,
        profileDir: identity.profileDir,
        state: s?.supervisor.status ?? 'stopped',
        tabs: s?.tabs.size ?? 0,
        browserWsUrl: (s && safe(() => s.supervisor.browserWsUrl)) ?? '',
      }
    })
  }

  async stopIdentity(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    await s.tabs.releaseAll().catch(() => {})
    await s.supervisor.stop()
  }

  /**
   * Stop the identity (if running) and delete its profile dir - the only operation that destroys durable
   * state. Stopping first is not optional: Chrome must release the profile and flush before the dir goes, or
   * we unlink files out from under a live process. Irreversible; the signed-in session cannot be recovered.
   */
  async deleteIdentity(id: string): Promise<void> {
    await this.stopIdentity(id)
    this.registry.remove(id)
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
