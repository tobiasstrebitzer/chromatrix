// TabPool - exclusive, per-agent tab leasing for ONE identity (PRD §4; S3 proved tab affinity is mandatory:
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
  async lease(agentId: string, opts: { url?: string } = {}): Promise<Lease> {
    if (this.leases.size >= this.maxTabs) {
      throw new Error(`identity "${this.identity}" tab cap reached (${this.maxTabs})`)
    }
    const { targetId } = await this.client.send<{ targetId: string }>('Target.createTarget', {
      url: opts.url ?? 'about:blank',
      newWindow: true,
    })
    const lease: Lease = { identity: this.identity, agentId, targetId, createdAt: new Date().toISOString() }
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
