// TabPool - exclusive, per-agent tab leasing for ONE identity (S3 proved tab affinity is mandatory:
// a tab is owned by exactly one agent at a time, because a second agent navigating a leased tab destroys the
// first's in-flight op). Each lease is a real CDP page target created on the identity's shared default context
// (so it inherits the persistent login - S3 showed ephemeral contexts do NOT). The pool tracks which agent
// owns which targetId; the gateway turns that ownership into the mux's per-tab ACL scope.

import type { CdpClient } from '@chromatrix/cdp'

export interface Lease {
  readonly identity: string
  readonly agentId: string
  readonly targetId: string
  readonly createdAt: string
  /**
   * The agent asked for framework-compat (unmitigated protocol) on this tab, so the URL minted for it carries
   * the flag. Compat is really a property of the CONNECTION, not the tab - it is recorded per lease only so
   * that every URL we hand back for this agent says the same thing, wherever it is read from.
   */
  readonly compat?: boolean
}

export interface TabPoolOptions {
  /** Hard cap on concurrent leased tabs for this identity (v1 budget: ~10 tabs across ≤5 identities). */
  maxTabs?: number
}

export class TabPool {
  private readonly leases = new Map<string, Lease>() // targetId → Lease
  private readonly maxTabs: number

  constructor(
    private readonly identity: string,
    private readonly client: CdpClient,
    options: TabPoolOptions = {},
  ) {
    this.maxTabs = options.maxTabs ?? 10
  }

  get size(): number {
    return this.leases.size
  }

  /**
   * Create a fresh tab on the shared default context and lease it exclusively to `agentId`.
   *
   * `newWindow: true` puts every tab in its own browser window. That is what makes viewport size a *per-tab*
   * property: window bounds are per-window, so tabs sharing a window would be forced to share a size. The
   * alternative - `Emulation.setDeviceMetricsOverride` - is per-target but produces states impossible on real
   * hardware (a viewport larger than its own window), which is exactly the kind of artifact this project
   * exists to avoid. See docs/FINDINGS.md.
   */
  async lease(agentId: string, opts: { url?: string; compat?: boolean } = {}): Promise<Lease> {
    if (this.leases.size >= this.maxTabs) {
      throw new Error(`identity "${this.identity}" tab cap reached (${this.maxTabs})`)
    }
    const { targetId } = await this.client.send<{ targetId: string }>('Target.createTarget', {
      url: opts.url ?? 'about:blank',
      newWindow: true,
    })
    return this.register(agentId, targetId, opts.compat)
  }

  /**
   * Lease a target the AGENT created itself (`Target.createTarget` over its own CDP connection - Playwright's
   * `newPage()`). The tab already exists; this is what stops it being an unowned window that the ACL hides
   * from its own creator and that no release will ever reap. The cap still applies: a client cannot mint
   * unlimited tabs just by going around `allocateTab`.
   */
  adopt(agentId: string, targetId: string, opts: { compat?: boolean } = {}): Lease {
    const existing = this.leases.get(targetId)
    if (existing) return existing
    if (this.leases.size >= this.maxTabs) {
      throw new Error(`identity "${this.identity}" tab cap reached (${this.maxTabs})`)
    }
    return this.register(agentId, targetId, opts.compat)
  }

  private register(agentId: string, targetId: string, compat?: boolean): Lease {
    const lease: Lease = {
      identity: this.identity,
      agentId,
      targetId,
      createdAt: new Date().toISOString(),
      ...(compat ? { compat: true } : {}),
    }
    this.leases.set(targetId, lease)
    return lease
  }

  /** Release (and close) a leased tab. No-op if the targetId isn't leased here. */
  async release(targetId: string): Promise<void> {
    if (!this.leases.delete(targetId)) return
    await this.client.send('Target.closeTarget', { targetId }).catch(() => {
      /* target may already be gone (crash/manual close); the lease is dropped regardless */
    })
  }

  /** Drop a lease WITHOUT closing the target - for a tab the agent closed itself, which is already gone. */
  drop(targetId: string): void {
    this.leases.delete(targetId)
  }

  /** The lease for a targetId, if any. */
  get(targetId: string): Lease | undefined {
    return this.leases.get(targetId)
  }

  /** True if `agentId` currently leases `targetId` - the ACL predicate the mux scope calls. */
  isLeasedBy(agentId: string, targetId: string): boolean {
    return this.leases.get(targetId)?.agentId === agentId
  }

  /** All targetIds currently leased by `agentId` (an agent may hold several tabs on one connection). */
  targetsFor(agentId: string): string[] {
    const out: string[] = []
    for (const lease of this.leases.values()) if (lease.agentId === agentId) out.push(lease.targetId)
    return out
  }

  list(): Lease[] {
    return [...this.leases.values()]
  }

  /** Close every leased tab (used on identity shutdown). */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.leases.keys()].map((id) => this.release(id)))
  }
}
