// @chromatrix/core — identity registry, session/tab-pool orchestration, single-writer profile locking, health
// checks, and the orphaned-Chrome-tree reaper. The domain the gateway (apps/gateway) drives; no HTTP/WS here.
// See docs/PRD.md §4. Built on the S1 (mux) + S3 (concurrency) findings.

export { IdentityRegistry, assertValidIdentityId, type Identity } from './identity.ts'
export { ProfileLock, ProfileLockError } from './profile-lock.ts'
export { findChromePidsForProfile, reapProfile } from './reaper.ts'
export { ChromeSupervisor, type SupervisorOptions, type SupervisorState } from './supervisor.ts'
export { TabPool, type Lease, type TabPoolOptions } from './tab-pool.ts'
export {
  Orchestrator,
  type OrchestratorOptions,
  type Session,
  type SessionInfo,
} from './orchestrator.ts'

export const CORE_PACKAGE = '@chromatrix/core' as const
