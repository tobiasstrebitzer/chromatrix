// CdpGatewayService — the gateway's control plane. Wraps @chromatrix/core's Orchestrator (identities +
// Chrome supervisors + tab leasing) and adds the two things the domain layer deliberately doesn't know
// about: (1) a per-identity CdpMux (upstream-only, embedded — fed already-upgraded sockets by the raw
// `upgrade` handler, never a self-hosted server) carrying the Runtime.enable-suppression interceptor, and
// (2) the token→lease table that turns an `allocateTab` into a scoped, single-use `…/cdp/<id>?token=…` URL.
//
// The per-tab ACL is NOT stored — it is derived live from the TabPool on every attach, so lease/release
// takes effect immediately: a client's scope `allows(t)` iff its agent currently leases target `t`.
// See docs/PRD.md §4/§6 and NEXT-SESSION §2–3.

import { randomUUID } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { CdpMux, type ClientScope } from '@chromatrix/cdp'
import { runtimeEnableSuppressInterceptor } from '@chromatrix/fidelity'
import {
  IdentityRegistry,
  Orchestrator,
  assertValidIdentityId,
  type Lease,
  type SessionInfo,
} from '@chromatrix/core'

export interface AllocatedTab {
  identity: string
  agentId: string
  targetId: string
  createdAt: string
  /** Scoped, agent-bound raw-CDP endpoint. The agent connects a raw CdpClient here and drives its tab(s). */
  cdpUrl: string
}

interface TokenGrant {
  identity: string
  agentId: string
}

/** A running identity plus the tabs it currently leases — what the dashboard renders per card. */
export interface SessionView extends SessionInfo {
  leases: AllocatedTab[]
}

/** A live page target in an identity's Chrome, annotated with the agent leasing it (if any). */
export interface TargetView {
  targetId: string
  url: string
  title: string
  agentId?: string
}

@Injectable()
export class CdpGatewayService {
  private readonly log = new Logger('CdpGateway')
  private readonly orchestrator: Orchestrator
  /** One upstream mux per running identity (created on start, closed on stop). */
  private readonly muxes = new Map<string, CdpMux>()
  /** Opaque bearer token → the (identity, agent) it authenticates. The scope is derived live, not stored. */
  private readonly tokens = new Map<string, TokenGrant>()
  /** Reverse index `identity\0agentId` → token, so an agent keeps ONE stable credential across allocations. */
  private readonly agentTokens = new Map<string, string>()

  /** Public WS origin the scoped cdpUrl is built from (e.g. `ws://127.0.0.1:8830`). Set in main.ts after listen. */
  publicWsOrigin = ''

  /** The same origin as HTTP (for the takeover viewer URL): `ws://` → `http://`, `wss://` → `https://`. */
  publicHttpOrigin(): string {
    return this.publicWsOrigin.replace(/^ws/, 'http')
  }

  constructor(profilesRoot: string) {
    this.orchestrator = new Orchestrator(new IdentityRegistry(profilesRoot))
  }

  // ── Provisioning (the MCP/management surface calls these) ───────────────────────────────────────────────

  createIdentity(id: string): { id: string; profileDir: string } {
    assertValidIdentityId(id)
    const identity = this.orchestrator.createIdentity(id)
    this.log.log(`created identity "${id}" → ${identity.profileDir}`)
    return { id: identity.id, profileDir: identity.profileDir }
  }

  async startIdentity(id: string, opts: { headless?: boolean } = {}): Promise<SessionInfo> {
    assertValidIdentityId(id)
    const session = await this.orchestrator.startIdentity(id, { headless: opts.headless })
    if (!this.muxes.has(id)) {
      const mux = await CdpMux.connect({
        browserWsUrl: session.supervisor.browserWsUrl,
        interceptor: runtimeEnableSuppressInterceptor,
      })
      this.muxes.set(id, mux)
    }
    this.log.log(`started identity "${id}"${opts.headless ? ' (headless)' : ''}`)
    return this.sessionInfo(id)
  }

  /**
   * Running sessions, each with the tabs it currently leases. The leases live in the TabPool (the gateway is
   * the source of truth), so a dashboard reload re-renders the real tab list instead of an empty one.
   */
  listSessions(): SessionView[] {
    return this.orchestrator.listSessions().map((s) => ({ ...s, leases: this.listTabs(s.identity) }))
  }

  /** The tabs currently leased under `identity`, each with the scoped URL its agent connects on. */
  listTabs(identity: string): AllocatedTab[] {
    if (!this.orchestrator.isRunning(identity)) return []
    return this.orchestrator
      .session(identity)
      .tabs.list()
      .map((lease) => this.describeTab(lease, this.tokenFor(lease.identity, lease.agentId)))
  }

  /**
   * Live page targets in an identity's Chrome, annotated with the leasing agent. This is what the takeover
   * viewer picks from: it lists what a human can actually look at, which is broader than the lease table
   * (a tab the agent navigated to a popup, say, is still a real page).
   */
  async listTargets(identity: string): Promise<TargetView[]> {
    if (!this.orchestrator.isRunning(identity)) return []
    const tabs = this.orchestrator.session(identity).tabs
    const { targetInfos } = await this.controlClient(identity).send<{
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>
    }>('Target.getTargets')
    return targetInfos
      .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, agentId: tabs.get(t.targetId)?.agentId }))
  }

  /** Lease a fresh tab for `agentId` under `identity` and hand back the scoped URL the agent connects with. */
  async allocateTab(identity: string, agentId: string, opts: { url?: string } = {}): Promise<AllocatedTab> {
    assertValidIdentityId(identity)
    if (!this.muxes.has(identity)) {
      throw new Error(`identity "${identity}" is not running — startIdentity first`)
    }
    const lease = await this.orchestrator.allocateTab(identity, agentId, opts)
    return this.describeTab(lease, this.tokenFor(identity, agentId))
  }

  async releaseTab(identity: string, targetId: string): Promise<void> {
    assertValidIdentityId(identity)
    await this.orchestrator.releaseTab(identity, targetId)
  }

  async health(identity: string): Promise<{ identity: string; product: string }> {
    assertValidIdentityId(identity)
    return { identity, product: await this.orchestrator.health(identity) }
  }

  async stopIdentity(id: string): Promise<void> {
    assertValidIdentityId(id)
    this.muxes.get(id)?.close()
    this.muxes.delete(id)
    for (const [token, grant] of this.tokens) {
      if (grant.identity === id) {
        this.tokens.delete(token)
        this.agentTokens.delete(`${grant.identity}\u0000${grant.agentId}`)
      }
    }
    await this.orchestrator.stopIdentity(id)
  }

  async shutdown(): Promise<void> {
    for (const mux of this.muxes.values()) mux.close()
    this.muxes.clear()
    this.tokens.clear()
    this.agentTokens.clear()
    await this.orchestrator.shutdown()
  }

  // ── Raw-CDP upgrade path (the http `upgrade` handler calls this) ─────────────────────────────────────────

  /** Resolve a `/cdp/<identity>?token=…` upgrade to the mux + the live per-tab ACL scope, or throw. */
  resolveCdpUpgrade(identity: string, token: string | undefined): { mux: CdpMux; scope: ClientScope } {
    if (!token) throw new Error('missing token')
    const grant = this.tokens.get(token)
    if (!grant) throw new Error('unknown or expired token')
    if (grant.identity !== identity) throw new Error(`token is not valid for identity "${identity}"`)
    const mux = this.muxes.get(identity)
    if (!mux) throw new Error(`identity "${identity}" is not running`)
    return { mux, scope: this.scopeFor(identity, grant.agentId) }
  }

  /** Control CDP client for a running identity — used by the takeover route. */
  controlClient(identity: string) {
    return this.orchestrator.client(identity)
  }

  isRunning(id: string): boolean {
    return this.orchestrator.isRunning(id)
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────

  /** The live ACL: an agent's client may see/attach exactly the targets its TabPool leases grant, right now. */
  private scopeFor(identity: string, agentId: string): ClientScope {
    const tabs = this.orchestrator.session(identity).tabs
    return {
      identity,
      allows: (targetId) => tabs.isLeasedBy(agentId, targetId),
      allowedTargets: () => tabs.targetsFor(agentId),
    }
  }

  /**
   * The agent's CDP credential. Reused across that agent's allocations rather than minted per tab: an agent
   * holds one connection for all its tabs (the scope is derived live from the leases), and a stable token is
   * what lets `listSessions` hand back a working cdpUrl for tabs leased before the page was reloaded.
   */
  private tokenFor(identity: string, agentId: string): string {
    const key = `${identity}\u0000${agentId}` // NUL separates the parts unambiguously
    const existing = this.agentTokens.get(key)
    if (existing) return existing
    const token = randomUUID().replaceAll('-', '')
    this.tokens.set(token, { identity, agentId })
    this.agentTokens.set(key, token)
    return token
  }

  private describeTab(lease: Lease, token: string): AllocatedTab {
    return {
      identity: lease.identity,
      agentId: lease.agentId,
      targetId: lease.targetId,
      createdAt: lease.createdAt,
      cdpUrl: `${this.publicWsOrigin}/cdp/${lease.identity}?token=${token}`,
    }
  }

  private sessionInfo(id: string): SessionInfo {
    const info = this.orchestrator.listSessions().find((s) => s.identity === id)
    if (!info) throw new Error(`identity "${id}" is not running`)
    return info
  }
}
