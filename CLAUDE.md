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
takeover route. Two end-to-end tests drive real Chrome + real CDP and pass: `run accept` (single-identity ACL)
and `run e2e` (multi-session: concurrent identities × agents × tabs — parallelism + isolation + teardown under
load). The **`apps/web` dashboard is now built too** (React/Vite/Tailwind-v4 on the gtm design system, tRPC to
the gateway, single-origin dev-proxy/prod-serve). What remains is validation + prod hardening. See NEXT-SESSION.md.

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
  gateway/    @chromatrix/gateway — NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + silkweave tRPC/MCP mgmt + takeover
              src/{gateway,cdp,takeover,common,e2e}/ — grouped by concern (not flat)
  web/        @chromatrix/web     — React 19 + Vite + Tailwind v4 dashboard (Sessions + Takeover), gtm design system, tRPC client
              src/{styles,lib,components/{brand,shell,ui},views,generated}/
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
  `@silkweave/{mcp,trpc,typegen}` (each adapter is an optional peer; add them explicitly). NestJS needs
  decorator metadata, so `apps/gateway` carries its own `.swcrc` (`legacyDecorator` + `decoratorMetadata`).
- **Single-origin web** (mirrors gtm): the gateway is the only origin. In **dev** it reverse-proxies non-API
  routes to Vite (`VITE_DEV_URL`, HMR); in **prod** `ServeStaticModule` serves `apps/web/dist`. The SPA uses
  relative URLs in both — no CORS. Controller REST is under `/api` (`@Controller('api')`); `/trpc` + `/mcp` are
  silkweave adapter transports; `typegen` emits `apps/web/src/generated/appRouter.d.ts` (committed, regen on boot).
- **apps/web** is React 19 + Vite + **Tailwind v4** (CSS-first `@theme`, no config file) + TanStack Router
  (hash history). Design system ported from gtm: CSS-variable tokens (light/dark on `data-theme`), `cn()` with
  an extended tailwind-merge for the custom text scale, Inter + JetBrains Mono via `@fontsource`.
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
pnpm --filter @chromatrix/gateway run start    # boot the gateway (PORT=8830; API /api, tRPC /trpc, MCP /mcp, CDP /cdp/<id>)
pnpm --filter @chromatrix/gateway run accept   # single-identity acceptance test (real Chrome; HEADLESS=1 for no window)
pnpm --filter @chromatrix/gateway run e2e      # multi-session parallel e2e (IDENTITIES/AGENTS_PER_IDENTITY/TABS_PER_AGENT; HEADLESS=0 to watch)

# dashboard (apps/web)
pnpm dev                                       # dev: Vite (:5181) + gateway proxying to it for HMR — open the gateway origin
pnpm --filter @chromatrix/web run build        # prod build → gateway's ServeStatic serves apps/web/dist on one port
```

## Status at a glance

| Component | Result |
|---|---|
| S1 mux | Runtime.enable getter-leak already closed on Chrome 150; proxy-side suppression works, consumer still evaluates |
| S2 fidelity | Authentic Apple/M3 Metal WebGL confirmed; fixed `navigator.webdriver` mismatch; ~8.5 GB for v1 fleet; x.com signed-in ✓, DataDome/std-Cloudflare PASS, managed-challenge GATED (→ human takeover) |
| S3 concurrency | shared context + tab affinity is the sound v1 model; ephemeral contexts don't inherit the login |
| S4 takeover | screencast + `isTrusted` input proven; used for a real human x.com login |
| **gateway** | **built + green**: Nest/MCP provisioning (8 tools) + raw-WS CDP mux outside Nest + live per-tab ACL + takeover route; acceptance test proves agent A evaluates in its tab and is **denied** attaching to agent B's target |
| **multi-session e2e** | **built + green**: `run e2e` runs a concurrent fleet (verified 3 identities × 3 agents × 2 tabs = 18 tabs) — parallelism (wall ≪ Σ), per-agent marker isolation, same-identity + cross-identity ACL denial, live churn, and zero-survivor teardown all pass |
| **apps/web** | **built + green**: React/Vite/Tailwind-v4 dashboard (Sessions provisioning + Takeover live-view) on the gtm design system, tRPC client to the gateway; dev-proxy + prod-serve both verified; renders in real headless Chrome with no console errors |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: skip (no tests yet; Vitest is wired for when there are)
- push: no (no git remote configured)
- version_bump: no (pre-release, private)
- publish: no (all packages private)
- docs: `docs/` folder (PRD, FINDINGS, NEXT-SESSION) with this CLAUDE.md as the index
- frontend_smoke: `pnpm --filter @chromatrix/web run build` then load the gateway-served dashboard in a real headless Chrome and assert React mounts with no console errors (see the session's verify-web smoke); a Vitest/Playwright harness is a future add
- co_authored_by: no (global — `includeCoAuthoredBy: false` in ~/.claude/settings.json)
