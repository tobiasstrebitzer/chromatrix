# Spike S3 — shared-tab concurrency vs isolated contexts

**Research question (docs/PRD.md §7, S3):** does "shared tabs, one context per identity" hold up when
several agents drive one identity at once, and what breaks? And the flagged alternative: does per-job
`Target.createBrowserContext` isolation break the persistent login?

## Run it

```bash
pnpm s3            # from repo root — headless by default
HEADLESS=0 pnpm s3 # watch it
```

Uses `https://example.com` as a real origin so cookies/localStorage behave realistically. One Chrome =
"one identity".

## Recorded result (Chrome 150, 2026-07)

**A) Shared context, one tab per agent (the chosen v1 model)** — ✅ sound
- 5 concurrent agents all completed without CDP error (multi-session CDP is robust).
- A cookie set by one agent is visible to all agents → the shared login works as intended.
- Every agent's `localStorage` write is present in a fresh tab → shared origin storage.
- ⚠ Agents racing on the **same** key are last-writer-wins (`shared` ended `"agent4"`).

**B) Navigation stomping (two agents forced onto ONE tab)** — ❌ breaks
- An agent navigating the tab destroyed another agent's in-flight evaluation
  (`Inspected target navigated or closed`).

**C) Per-job isolated browser contexts (the alternative)** — isolates, but breaks login
- `localStorage` and cookies are isolated across contexts (same origin). ✅
- A persistent (default-context) login cookie is **NOT** visible inside an ephemeral context. ✅ confirmed
  the tradeoff: an ephemeral context does not inherit the identity's login.

## Verdict → orchestrator rules

1. **v1 = shared context per identity + tab affinity.** Many agents drive one identity concurrently, each
   in its **own** tab, all sharing the login — as designed and now verified.
2. **One tab is owned by one agent at a time.** Never hand a tab that is mid-operation to another agent;
   navigation destroys its execution context. The orchestrator's tab pool must lease exclusively.
3. **Shared storage/cookies are last-writer-wins.** Agents namespace their own keys; the orchestrator owns
   any genuinely shared cross-agent state, not the page.
4. **Ephemeral contexts are the wrong tool for per-job isolation under one identity** (they don't inherit
   the login) — reserve `createBrowserContext` for genuinely anonymous jobs, or inject login cookies into
   each context if isolation under a logged-in identity is ever required.

## Still open (not tested here)

Dynamic **HSTS** and **TLS-session-cache** leakage between the default context and ephemeral contexts
(PRD §6 flagged unknowns) — these are the two credible cross-context linkability vectors and need a
dedicated probe before relying on `createBrowserContext` for anonymity.
