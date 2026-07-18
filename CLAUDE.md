# chromatrix

Self-hosted multi-session, multi-tab **headed-Chrome CDP orchestration** for Mac. One long-lived real Chrome
per identity, many concurrent tabs driven by remote agents over a **mitigating CDP gateway**, plus live-view
+ human takeover. Dev on a MacBook Pro; prod later on a Mac mini via Tailscale.

> **Responsible use.** chromatrix runs a *real* browser so that **authorized** automation behaves
> authentically — not to conceal unauthorized activity. Automate accounts you own or are permitted to
> automate; respect Terms of Service, `robots`, and rate limits. It is **not** for defeating access controls,
> ban evasion, credential stuffing, ToS-violating scraping, or mass abuse. Interactive human-verification
> gates (CAPTCHAs, managed challenges) are completed by a **human** via takeover, never auto-solved. The
> design goal is *fidelity* (a genuine browser presenting as itself), not evasion. See [`docs/PRD.md`](docs/PRD.md) §0.

The four foundational risks have been de-risked with runnable spikes, the proven primitives are consolidated
into `packages/`, and the **gateway (`apps/gateway`) is now built and running**: NestJS + `@silkweave/nestjs`
MCP provisioning surface, the raw-WS CDP mux mounted outside Nest's pipeline with a live per-tab ACL, and the
takeover route. An end-to-end acceptance test (`pnpm --filter @chromatrix/gateway run accept`) drives real
Chrome + real CDP and passes. Next is a **multi-session parallel e2e test** (concurrent identities × agents ×
tabs — isolation + throughput under load), then `apps/web` (the viewer/takeover SPA). See NEXT-SESSION.md.

## Docs — read these for context

- [`docs/PRD.md`](docs/PRD.md) — the product & architecture spec. Scoping decisions, the architectural crux
  ("mitigating mux, not transparent proxy"), the component design, and per-spike **status notes with results**.
  **Start here.**
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — one-page consolidated summary of what every spike proved (S1–S4 +
  the compatibility test against protected sites). The fastest way to load "what do we know".
- [`docs/NEXT-SESSION.md`](docs/NEXT-SESSION.md) — the continuation handoff: what to build next (`apps/web` +
  the open validation threads) and how.
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original research brief that kicked this off.
- Per-spike READMEs under `spikes/*/README.md` — how to run each spike and its recorded result.

## Layout

```
packages/
  cdp/        @chromatrix/cdp     — CdpClient + CdpMux (id-remap, sessionId routing, Interceptor seam)
  fidelity/   @chromatrix/fidelity — launchChrome + fingerprint-hygiene launch flags + runtimeEnableSuppressInterceptor
  core/       @chromatrix/core    — identity registry, tab pool, profile lock, reaper, supervisor, orchestrator
apps/
  gateway/    @chromatrix/gateway — NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + silkweave MCP mgmt + takeover
  web/        @chromatrix/web     — (placeholder) React/Vite viewer + takeover SPA
spikes/       s1-cdp-mux · s2-fidelity-baseline · s3-concurrency · s4-viewer-takeover  (throwaway, proven)
```

## Toolchain & conventions (mirrors `~/projects/mini/gtm`)

- **pnpm 11** workspace, **Node 24**, ESM everywhere. **Turbo** orchestrates `build`/`typecheck`/`test`/`dev`.
- **TypeScript via `tsgo`** (`@typescript/native-preview`) for typecheck — **no `tsc`**. **oxlint** only (no Prettier/ESLint).
- Libraries build with **tsdown** (ESM + `.d.mts`), **only on prepack/CI** — never in dev.
- **`@chromatrix/source` export condition**: apps/spikes resolve workspace packages straight to TS source in
  dev (no build step). Runtime needs `node --conditions=@chromatrix/source --import @swc-node/register/esm-register`;
  tsconfigs set `customConditions: ["@chromatrix/source"]` + `allowImportingTsExtensions`.
- **Vitest** is the test runner (installed; no tests written yet).
- **silkweave** (`@silkweave/*`) is the API/MCP/tRPC toolkit — the gateway uses `@silkweave/nestjs` +
  `@silkweave/mcp` (the MCP adapter is an optional peer; add it explicitly). NestJS needs decorator metadata,
  so `apps/gateway` carries its own `.swcrc` (`legacyDecorator` + `decoratorMetadata`) mirroring gtm's.
- Real Chrome binary: `/Applications/Google Chrome.app` (v150). Persistent identity profiles live under
  `.profiles/<id>/` (**gitignored** — contains session cookies).

## Running things

```bash
pnpm install
pnpm lint          # oxlint
pnpm typecheck     # turbo → tsgo per package
pnpm s1            # spike S1 — mitigating CDP mux (HEADLESS=1 to hide the window)
pnpm s2            # spike S2 — headed fidelity + capacity baseline
pnpm s2:targets    # spike S2 — logged-in target matrix (PROFILE_DIR=abs/path, optional CLOUDFLARE_URL/DATADOME_URL)
pnpm s3            # spike S3 — shared-tab concurrency
pnpm s4            # spike S4 — live-view + takeover login tool (START_URL=… PROFILE_DIR=… )
pnpm s4:test       # spike S4 — automated mechanism self-test

# gateway (apps/gateway) — the real control plane
pnpm --filter @chromatrix/gateway run start    # boot the gateway (PORT=8830; MCP at /mcp, CDP at /cdp/<id>)
pnpm --filter @chromatrix/gateway run accept   # end-to-end acceptance test (real Chrome; HEADLESS=1 for no window)
```

## Status at a glance

| Component | Result |
|---|---|
| S1 mux | Runtime.enable getter-leak already closed on Chrome 150; proxy-side suppression works, consumer still evaluates |
| S2 fidelity | Authentic Apple/M3 Metal WebGL confirmed; fixed `navigator.webdriver` mismatch; ~8.5 GB for v1 fleet; x.com signed-in ✓, DataDome/std-Cloudflare PASS, managed-challenge GATED (→ human takeover) |
| S3 concurrency | shared context + tab affinity is the sound v1 model; ephemeral contexts don't inherit the login |
| S4 takeover | screencast + `isTrusted` input proven; used for a real human x.com login |
| **gateway** | **built + green**: Nest/MCP provisioning (8 tools) + raw-WS CDP mux outside Nest + live per-tab ACL + takeover route; acceptance test proves agent A evaluates in its tab and is **denied** attaching to agent B's target |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: skip (no tests yet; Vitest is wired for when there are)
- push: no (no git remote configured)
- version_bump: no (pre-release, private)
- publish: no (all packages private)
- docs: `docs/` folder (PRD, FINDINGS, NEXT-SESSION) with this CLAUDE.md as the index
- frontend_smoke: no (apps/web is a placeholder)
- co_authored_by: no (global — `includeCoAuthoredBy: false` in ~/.claude/settings.json)
