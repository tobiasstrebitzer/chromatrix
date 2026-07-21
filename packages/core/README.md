# @chromatrix/core

Domain core for [chromatrix](../../README.md): identity registry, session/tab-pool orchestration,
single-writer profile locking, health checks, and the orphaned-Chrome-tree reaper. Knows nothing about
HTTP/WS/CDP-wire-format - [`apps/gateway`](../../apps/gateway) layers that on top.

```sh
pnpm add @chromatrix/core
```

## What it does

- **`Orchestrator`** - the domain facade: create/start/stop/delete identities, allocate/release tabs, health
  checks, `listSessions()`. One Chrome per identity, a shared default context, exclusive per-agent tab
  leasing - the concurrency model [`docs/FINDINGS.md`](../../docs/FINDINGS.md) (S3) validated.
- **`IdentityRegistry`** - durable identities on disk (`.profiles/<id>/`); an identity persisting is separate
  from it being *running*, so `stopped` is a resting state, not an absence.
- **`ChromeSupervisor`** - owns one identity's Chrome process lifecycle: acquires the profile lock, reaps any
  orphaned Chrome tree, launches via [`@chromatrix/fidelity`](../fidelity), opens the control `CdpClient`.
  `stop()` waits for the process to actually exit (not just SIGTERM) before releasing the lock.
- **`TabPool`** - exclusive per-agent tab leasing under a running identity; two agents can never be forced
  onto the same tab.
- **`ProfileLock`** - an atomic single-writer lock per profile dir, so two supervisors never race on the same
  `--user-data-dir`. Stale locks (from a hard-killed prior run) are reclaimed automatically.
- **`reapProfile`** - finds and cleans up an orphaned Chrome process tree still bound to a profile dir.

## Development

```sh
pnpm --filter @chromatrix/core run typecheck
pnpm --filter @chromatrix/core run test
pnpm --filter @chromatrix/core run build   # tsdown → build/ (only on prepack/CI)
```

Part of the [chromatrix](../../README.md) monorepo - see the root README for the full architecture.
