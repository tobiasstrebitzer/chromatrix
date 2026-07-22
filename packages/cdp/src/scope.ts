// Per-client authorization scope for the mux - the "per-tab ACL" seam - see docs/FINDINGS.md.
// A downstream client attached to identity X may only see and attach the CDP targets its lease grants. The
// mux calls `allows(targetId)` on every target-scoped operation (attach, getTargets response, target
// lifecycle events). Under the orchestrator's leasing invariant each target is granted to at most ONE scope,
// so "which client may see target T" is unambiguous - that is what lets the mux route auto-attached sessions
// and target events to exactly the owning agent instead of broadcasting them.

export interface ClientScope {
  /** Identity this client is bound to (one Chrome/user-data-dir). Informational; routing is per-target. */
  readonly identity: string
  /** True if this client may see/attach the given targetId. Read live so lease/release takes effect at once. */
  allows(targetId: string): boolean
  /** Snapshot of the targetIds currently granted (used to filter Target.getTargets responses). */
  allowedTargets(): readonly string[]
  /**
   * Grant this client a target it created ITSELF (`Target.createTarget`, i.e. Playwright's `newPage()`).
   *
   * Without this a self-created tab is owned by nobody, so the ACL routes its own `Target.attachedToTarget`
   * away from the client that asked for it - the caller gets a targetId and no session, and the tab leaks
   * because no lease will ever reap it. Optional: a scope that cannot grant leases simply doesn't offer it,
   * and the mux then leaves such a target unowned (the pre-existing behaviour).
   */
  adopt?(targetId: string): void
  /** Drop the lease for a target the client closed itself (`Target.closeTarget`). The target is already gone. */
  release?(targetId: string): void
}

/** A scope that sees everything - the control/unscoped path (e.g. the orchestrator's own connection). */
export const unrestrictedScope: ClientScope = {
  identity: '*',
  allows: () => true,
  allowedTargets: () => [],
}
