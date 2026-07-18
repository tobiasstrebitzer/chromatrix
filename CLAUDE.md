# chromatrix

Self-hosted multi-session, multi-tab **headed-Chrome CDP orchestration** for Mac. One long-lived real Chrome
per identity, many concurrent tabs driven by remote agents over a **mitigating CDP gateway**, plus live-view
+ human takeover. Dev on a MacBook Pro; prod later on a Mac mini via Tailscale.

Currently in the **PRD / spike phase**: the four foundational risks have been de-risked with runnable spikes,
and the proven primitives are consolidated into `packages/`. Next is the real gateway (`apps/gateway`).

## Docs — read these for context

- [`docs/PRD.md`](docs/PRD.md) — the product & architecture spec. Scoping decisions, the architectural crux
  ("mitigating mux, not transparent proxy"), the component design, and per-spike **status notes with results**.
  **Start here.**
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — one-page consolidated summary of what every spike proved (S1–S4 +
  the stealth ceiling test). The fastest way to load "what do we know".
- [`docs/NEXT-SESSION.md`](docs/NEXT-SESSION.md) — the continuation handoff: what to build next (`apps/gateway`)
  and how, plus the open threads.
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original research brief that kicked this off.
- Per-spike READMEs under `spikes/*/README.md` — how to run each spike and its recorded result.

## Layout

```
packages/
  cdp/        @chromatrix/cdp     — CdpClient + CdpMux (id-remap, sessionId routing, Interceptor seam)
  stealth/    @chromatrix/stealth — launchChrome + stealth flags + runtimeEnableSuppressInterceptor
  core/       @chromatrix/core    — (skeleton) identity registry, tab pool, profile lock, orchestrator
apps/
  gateway/    @chromatrix/gateway — (placeholder) NestJS: raw-WS CDP mux + silkweave mgmt/MCP API
  web/        @chromatrix/web     — (placeholder) React/Vite viewer + takeover SPA
spikes/       s1-cdp-mux · s2-stealth-baseline · s3-concurrency · s4-viewer-takeover  (throwaway, proven)
```

## Toolchain & conventions (mirrors `~/projects/mini/gtm`)

- **pnpm 11** workspace, **Node 24**, ESM everywhere. **Turbo** orchestrates `build`/`typecheck`/`test`/`dev`.
- **TypeScript via `tsgo`** (`@typescript/native-preview`) for typecheck — **no `tsc`**. **oxlint** only (no Prettier/ESLint).
- Libraries build with **tsdown** (ESM + `.d.mts`), **only on prepack/CI** — never in dev.
- **`@chromatrix/source` export condition**: apps/spikes resolve workspace packages straight to TS source in
  dev (no build step). Runtime needs `node --conditions=@chromatrix/source --import @swc-node/register/esm-register`;
  tsconfigs set `customConditions: ["@chromatrix/source"]` + `allowImportingTsExtensions`.
- **Vitest** is the test runner (installed; no tests written yet).
- **silkweave** (`@silkweave/*`) is the API/MCP/tRPC toolkit — the gateway will use `@silkweave/nestjs`.
- Real Chrome binary: `/Applications/Google Chrome.app` (v150). Persistent identity profiles live under
  `.profiles/<id>/` (**gitignored** — contains session cookies).

## Running things

```bash
pnpm install
pnpm lint          # oxlint
pnpm typecheck     # turbo → tsgo per package
pnpm s1            # spike S1 — mitigating CDP mux (HEADLESS=1 to hide the window)
pnpm s2            # spike S2 — headed stealth + capacity baseline
pnpm s2:targets    # spike S2 — logged-in target matrix (PROFILE_DIR=abs/path, optional CLOUDFLARE_URL/DATADOME_URL)
pnpm s3            # spike S3 — shared-tab concurrency
pnpm s4            # spike S4 — live-view + takeover login tool (START_URL=… PROFILE_DIR=… )
pnpm s4:test       # spike S4 — automated mechanism self-test
```

## Status at a glance

| Spike | Result |
|---|---|
| S1 mux | Runtime.enable getter-leak already closed on Chrome 150; proxy-side suppression works, consumer still evaluates |
| S2 stealth | Apple/M3 Metal WebGL confirmed; fixed `navigator.webdriver` tell; ~8.5 GB for v1 fleet; x.com signed-in ✓, DataDome/std-Cloudflare PASS, managed-challenge GATED |
| S3 concurrency | shared context + tab affinity is the sound v1 model; ephemeral contexts don't inherit the login |
| S4 takeover | screencast + `isTrusted` input proven; used for a real human x.com login |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: skip (no tests yet; Vitest is wired for when there are)
- push: no (no git remote configured)
- version_bump: no (pre-release, private)
- publish: no (all packages private)
- docs: `docs/` folder (PRD, FINDINGS, NEXT-SESSION) with this CLAUDE.md as the index
- frontend_smoke: no (apps/web is a placeholder)
- co_authored_by: no (global — `includeCoAuthoredBy: false` in ~/.claude/settings.json)
