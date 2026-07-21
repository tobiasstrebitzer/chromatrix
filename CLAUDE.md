# chromatrix

Self-hosted multi-session, multi-tab **headed-Chrome CDP orchestration** for Mac — one long-lived real Chrome
per identity, many concurrent tabs over a **mitigating CDP gateway**, plus live-view + human takeover. Dev on
a MacBook Pro; prod later on a Mac mini via Tailscale. Full pitch + architecture in [`README.md`](README.md).

> **Responsible use.** Authorized automation only — not for defeating access controls, ban evasion, or
> ToS-violating scraping. Human-verification gates (CAPTCHAs, managed challenges) are completed by a
> **human** via takeover, never auto-solved. Fidelity, not evasion. See [`docs/PRD.md`](docs/PRD.md) §0.

## Docs — read these for context

- [`docs/PRD.md`](docs/PRD.md) — architecture spec, the "mitigating mux, not transparent proxy" crux,
  per-spike status notes. **Start here.**
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — one page of what every spike (S1–S4, now retired) proved.
- [`docs/NEXT-SESSION.md`](docs/NEXT-SESSION.md) — open threads + accumulated gotchas. No "what's built"
  inventory — that's the status table below.
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original research brief.

## Layout

```
packages/
  cdp/        @chromatrix/cdp     — CdpClient + CdpMux (id-remap, sessionId routing, Interceptor seam)
  fidelity/   @chromatrix/fidelity — launchChrome + fingerprint-hygiene flags + runtimeEnableSuppressInterceptor
  core/       @chromatrix/core    — identity registry, tab pool, profile lock, reaper, supervisor, orchestrator
  shared/     @chromatrix/shared  — config schema (zod) + access-token primitives; the CLI's only workspace dep
apps/
  gateway/    @chromatrix/gateway — NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + silkweave tRPC/MCP + takeover
              src/{gateway,auth,cdp,takeover,common,e2e}/ — grouped by concern (not flat)
  web/        @chromatrix/web     — React 19 + Vite + Tailwind v4 dashboard, achromatic design system, tRPC client
  cli/        @chromatrix/cli     — remote CLI over the gateway's MCP surface; NO per-command code, derived from `tools/list`
```

## Toolchain & conventions (mirrors `~/projects/mini/gtm`)

- **pnpm 11** workspace, **Node 24**, ESM everywhere. **Turbo** orchestrates `build`/`typecheck`/`test`/`dev`.
- **TypeScript via `tsgo`** for typecheck — **no `tsc`**. **oxlint** only (no Prettier/ESLint).
- Libraries + `apps/cli` + `apps/gateway` build with **tsdown**, **only on prepack/CI** — never in dev. The
  gateway's build routes the TS transform through `unplugin-swc` (oxc can't emit the decorator metadata Nest
  DI + ValidationPipe need), and its prepack copies the built dashboard into `<pkg>/web`.
- **`@chromatrix/source` export condition**: apps resolve workspace packages straight to TS source in dev.
  Runtime needs `node --conditions=@chromatrix/source --import @swc-node/register/esm-register`; tsconfigs
  set `customConditions: ["@chromatrix/source"]` + `allowImportingTsExtensions`.
- **silkweave** (`@silkweave/*`) is the API/MCP/tRPC toolkit. NestJS needs decorator metadata, so
  `apps/gateway` carries its own `.swcrc` (`legacyDecorator` + `decoratorMetadata`).
- **Single-origin web**: the gateway is the only origin — dev reverse-proxies to Vite (`VITE_DEV_URL`), prod
  `ServeStaticModule` serves `apps/web/dist`. REST under `/api`; `/trpc` + `/mcp` are silkweave transports;
  `typegen` emits `apps/web/src/generated/appRouter.d.ts` (committed, regen on boot).
- **apps/web**: Tailwind v4 (CSS-first `@theme`), TanStack Router (hash history), CSS-variable tokens
  (light/dark on `data-theme`), `@base-ui/react` (Select, AlertDialog) + `sonner` (toasts, themed via CSS
  vars not the `theme` prop). Inset ("framed") shell — **never put a `bg-*` utility on the frame** (`.frame-shine`
  paints the fill + gradient edge; a utility would paint over it). Achromatic: no brand hue, colour is
  reserved for state; the Logo's green is the one exception, deliberately not a token. The Logo
  (`components/brand/Logo.tsx`) runs on a single rAF controller — **position is never eased, only phase**.
- **One access token gates everything** — `Authorization: Bearer` for programmatic clients, an HttpOnly
  cookie for the dashboard, `?token=` on raw-WS upgrades; one constant-time comparison in `auth/auth.ts`.
  Guarding is per-surface: global `APP_GUARD` for `/api/*`, silkweave `auth` at the transport for `/trpc`+`/mcp`
  (closes `tools/list`), `/cdp`+`/takeover` self-check (a WS handshake never reaches a Nest guard).
  `cookieToBearer` must be registered before Nest initialises — see the gotcha in NEXT-SESSION.
- **Agents never hold the operator credential** — `/cdp` uses a derived per-agent token,
  `HMAC(accessToken, identity ‖ agentId)`: one-way and recomputed (no token table, no revocation per-agent).
- **Config**: `~/.config/chromatrix/config.json` (`0600`), overridden by `CHROMATRIX_*` env — bare
  `PORT`/`HOST` not read. Real Chrome: `/Applications/Google Chrome.app`. Profiles under `.profiles/<id>/`
  (gitignored). Identity ids are lowercase kebab slugs (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64).
- **`chrome-devtools-mcp`** is wired in `.mcp.json` — drive the dashboard in a real browser (`pnpm dev`,
  point it at the gateway origin) instead of guessing at UI behaviour.

## Running things

See [`README.md`](README.md) for the full command reference. Two gateway-only test commands not covered
there: `pnpm --filter @chromatrix/gateway run accept` (ACL + full auth perimeter, `HEADLESS=1`) and
`... run e2e` (multi-session parallel e2e, `HEADLESS=0` to watch).

## Status at a glance

| Component | Result |
|---|---|
| S1–S4 spikes | Retired; findings consolidated in `docs/FINDINGS.md`. Runtime.enable leak closed on Chrome 150; authentic Apple/M3 WebGL; shared-context + exclusive-tab-leasing is the sound concurrency model; screencast + `isTrusted` takeover input proven with a real human x.com login |
| gateway + auth | **built + verified**: Nest/MCP provisioning (15 tools) + raw-WS mux + live per-tab ACL + takeover; one access token across every surface, derived one-way per-agent CDP tokens; 10/10 acceptance |
| apps/cli, apps/web | **built + verified**: CLI has zero per-command code (derived from `tools/list`); dashboard (Sessions + Takeover) renders clean in real Chrome, dev-proxy + prod-serve both verified |
| session lifecycle | **built + verified**: create/start/stop/delete are four distinct verbs; `listSessions` left-joins the on-disk registry with running state so `stopped` is a resting state, not an absence |
| per-tab viewport, screenshots | **built + verified**: every tab is its own sized window (floor 500×288, no emulation fakery); `/api/tab/screenshot` is one silkweave binary resource serving `<img>`, MCP image block, and CLI stdout |
| multi-session e2e | **built + green**: concurrent fleet (3 identities × 3 agents × 2 tabs) — parallelism, isolation, ACL denial, zero-survivor teardown |
| publishing | **all six packages LIVE on npm at 0.1.0** (public, MIT, `chromatrix` org); `gateway` bundles the dashboard so `npx @chromatrix/gateway` is standalone. Published via keybridge + gatekeeper; note the `workspace:*` npm-publish gotcha in `docs/NEXT-SESSION.md` before the next release |
| gateway hardening | **built + verified**: global ValidationPipe (malformed DTO body → 400 at the edge) + sliding-window login throttle (429 + Retry-After, keyed by socket address); 13/13 acceptance |
| takeover UI | **built + verified in real Chrome**: browser-style tab strip (favicon/title/agent badge, inline release), Fit vs 1:1 zoom, keyboard-focus pill + auto-focus, per-control busy states on Sessions |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: skip (no tests yet; Vitest is wired for when there are)
- push: yes (`origin` = `git@github.com:tobiasstrebitzer/chromatrix.git`)
- version_bump: no (pre-release, stays 0.1.0 across all packages until told otherwise)
- publish: yes, manual only — `keybridge` after a `/gatekeeper` pass, explicit confirmation before any
  `npm publish`/`keybridge publish` is actually run
- docs: `docs/` folder (PRD, FINDINGS, NEXT-SESSION) with this CLAUDE.md as the index; root + per-package
  READMEs for the public-facing pitch
- frontend_smoke: `pnpm --filter @chromatrix/web run build` then load the gateway-served dashboard in a real
  headless Chrome and assert React mounts with no console errors; a Vitest/Playwright harness is a future add
- co_authored_by: no (global — `includeCoAuthoredBy: false` in ~/.claude/settings.json)
