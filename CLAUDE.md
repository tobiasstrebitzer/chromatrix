# chromatrix

Self-hosted multi-session, multi-tab **headed-Chrome CDP orchestration** for Mac: one long-lived real Chrome
per identity, many concurrent tabs over a **mitigating CDP gateway**, plus live-view + human takeover. Full pitch, architecture, and prod (Mac mini + Tailscale) notes in [`README.md`](README.md).

> **Responsible use.** Authorized automation only - not for defeating access controls, ban evasion, or
> ToS-violating scraping. Human-verification gates (CAPTCHAs, managed challenges) are completed by a
> **human** via takeover, never auto-solved. Fidelity, not evasion. See [`docs/FINDINGS.md`](docs/FINDINGS.md).

> **Writing (STRICT).** Never use em-dashes (`—`) or en-dashes (`–`) anywhere in this repo (code, comments,
> docs, commit messages, strings). Use a hyphen (`-`), or restructure. Box-drawing chars in ASCII diagrams
> (`─ │ ▶`) are fine; those are not dashes.

## Docs - read these for context

**`docs/` is public (it ships in the GitHub repo); `_docs/` is ours and is gitignored.** Anything written for
us rather than for a user of the project belongs in `_docs/` - and nothing tracked may link to it, or the
public repo ships a dangling pointer.

- Public docs site: `apps/docs` (Astro), deployed to GitHub Pages on push via `.github/workflows/docs.yml`.
  **This is where user-facing behaviour gets documented** - a flag with no page here effectively does not exist.
- [`docs/FINDINGS.md`](docs/FINDINGS.md) - one page of what every spike (S1-S4, now retired) proved, plus the
  responsible-use position. The public counterpart to the retired PRD. **Start here.**
- [`_docs/NEXT-SESSION.md`](_docs/NEXT-SESSION.md) - open threads + accumulated gotchas. No "what's built"
  inventory - that's the status table below. ([`_docs/BRIEF.md`](_docs/BRIEF.md) is the original brief.)
- The PRD was deleted once the code and the docs site carried its content; its compat-mode rationale now
  lives in `apps/docs/src/content/docs/fidelity.md`.

## Layout

```
packages/
  cdp/        @chromatrix/cdp     - CdpClient + CdpMux (id-remap, sessionId routing, Interceptor seam)
  fidelity/   @chromatrix/fidelity - launchChrome + fingerprint-hygiene flags + runtimeEnableSuppressInterceptor
  core/       @chromatrix/core    - identity registry, tab pool, profile lock, reaper, supervisor, orchestrator
  shared/     @chromatrix/shared  - config schema (zod) + access-token primitives; the CLI's only workspace dep
apps/
  gateway/    @chromatrix/gateway - NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + silkweave tRPC/MCP + takeover
              src/{gateway,auth,cdp,takeover,common,e2e}/ - grouped by concern (not flat)
  web/        @chromatrix/web     - React 19 + Vite + Tailwind v4 dashboard, achromatic design system, tRPC client
  cli/        @chromatrix/cli     - remote CLI over the gateway's MCP surface; NO per-command code, derived from `tools/list`
  docs/       @chromatrix/docs    - Astro docs site; tokens.css COPIED from apps/web; content in src/content/docs, IA in src/nav.ts
```

## Toolchain & conventions (mirrors `~/projects/mini/gtm`)

- **pnpm 11** workspace, **Node 24**, ESM everywhere. **Turbo** orchestrates `build`/`typecheck`/`test`/`dev`.
- **TypeScript via `tsgo`** for typecheck - **no `tsc`**. **oxlint** only (no Prettier/ESLint).
- Libraries + `apps/cli` + `apps/gateway` build with **tsdown** on **prepack/CI only** (never in dev); the
  gateway routes its TS transform through `unplugin-swc` (oxc can't emit the decorator metadata Nest DI +
  ValidationPipe need) and its prepack copies the built dashboard into `<pkg>/web`. `apps/docs` builds with Astro.
- **`@chromatrix/source` export condition**: apps resolve workspace packages straight to TS source in dev.
  Runtime needs `node --conditions=@chromatrix/source --import @swc-node/register/esm-register`; tsconfigs set
  `customConditions: ["@chromatrix/source"]` + `allowImportingTsExtensions`.
- **silkweave** (`@silkweave/*`) is the API/MCP/tRPC toolkit; NestJS needs decorator metadata, so
  `apps/gateway` carries its own `.swcrc` (`legacyDecorator` + `decoratorMetadata`).
- **Single-origin web**: the gateway is the only origin - dev reverse-proxies to Vite (`VITE_DEV_URL`), prod
  `ServeStaticModule` serves `apps/web/dist`. REST under `/api`; `/trpc` + `/mcp` are silkweave transports;
  `typegen` emits `apps/web/src/generated/appRouter.d.ts` (committed).
- **apps/web**: Tailwind v4 (CSS-first `@theme`), TanStack Router (hash history), CSS-var tokens (light/dark
  on `data-theme`), `@base-ui/react` + `sonner`. Inset ("framed") shell - **never put a `bg-*` utility on the
  frame** (`.frame-shine` paints fill + edge). Achromatic: colour is reserved for state; the Logo's green is
  the one exception, not a token. The Logo runs on a single rAF controller - **position is never eased, only
  phase** (`apps/docs` re-ports this as a vanilla `Logo.astro`; keep the two in step).
- **One access token gates everything** - `Bearer` for programmatic clients, an HttpOnly cookie for the
  dashboard, `?token=` on raw-WS upgrades; one constant-time compare in `auth/auth.ts`. Guarding is
  per-surface: `APP_GUARD` for `/api/*`, silkweave `auth` at the transport for `/trpc`+`/mcp` (closes
  `tools/list`), `/cdp`+`/takeover` self-check (a WS handshake never reaches a Nest guard). `cookieToBearer`
  must register before Nest initialises (gotcha in `_docs/NEXT-SESSION.md`). Agents never hold the operator credential:
  `/cdp` uses a derived per-agent token `HMAC(accessToken, identity || agentId)` - one-way, recomputed.
- **Config**: `~/.config/chromatrix/config.json` (`0600`), overridden by `CHROMATRIX_*` env - bare
  `PORT`/`HOST` not read. Real Chrome: `/Applications/Google Chrome.app`. Profiles under `.profiles/<id>/`
  (gitignored). Identity ids are lowercase kebab slugs (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64).
- **`chrome-devtools-mcp`** is wired in `.mcp.json` - drive the dashboard in a real browser (`pnpm dev`,
  point it at the gateway origin) instead of guessing at UI behaviour.

## Running things

See [`README.md`](README.md) for the full command reference. Gateway-only tests: `pnpm --filter
@chromatrix/gateway run accept` (ACL + auth perimeter, `HEADLESS=1`), `... run e2e` (multi-session
parallel e2e, `HEADLESS=0` to watch), `... run takeover` (takeover input: drag-select, click counts,
modifiers, clipboard), and `... run pw` (Playwright `connectOverCDP` regression;
`TRACE=1` relays every CDP frame through a logging pass-through, which is the only way to debug this class
of bug - `accept`/`e2e` drive a bare `CdpClient` and stay green through framework-client breakage).

## Status at a glance

| Component | Result |
|---|---|
| S1-S4 spikes | Retired; findings consolidated in `docs/FINDINGS.md`. Runtime.enable leak closed on Chrome 150; authentic Apple/M3 WebGL; shared-context + exclusive-tab-leasing is the sound concurrency model; screencast + `isTrusted` takeover input proven with a real human x.com login |
| gateway + auth | **built + verified**: Nest/MCP provisioning (15 tools) + raw-WS mux + live per-tab ACL + takeover; one access token across every surface, derived one-way per-agent CDP tokens; 10/10 acceptance |
| apps/cli, apps/web | **built + verified**: CLI has zero per-command code (derived from `tools/list`); dashboard (Sessions + Takeover) renders clean in real Chrome, dev-proxy + prod-serve both verified |
| session lifecycle | **built + verified**: create/start/stop/delete are four distinct verbs; `listSessions` left-joins the on-disk registry with running state so `stopped` is a resting state, not an absence |
| per-tab viewport, screenshots | **built + verified**: every tab is its own sized window (floor 500×288, no emulation fakery); `/api/tab/screenshot` is one silkweave binary resource serving `<img>`, MCP image block, and CLI stdout |
| multi-session e2e | **built + green**: concurrent fleet (3 identities × 3 agents × 2 tabs) - parallelism, isolation, ACL denial, zero-survivor teardown |
| publishing + docs | **all six packages LIVE on npm at 0.1.0** (public, MIT, `chromatrix` org); `gateway` bundles the dashboard so `npx @chromatrix/gateway` is standalone. **Release = push a `vX.Y.Z` tag** -> `.github/workflows/publish.yml` publishes via npm Trusted Publishing (OIDC, no token; `pnpm publish -r` rewrites `workspace:*`). `apps/docs` (Astro) auto-deploys to GitHub Pages on push |
| gateway hardening | **built + verified**: global ValidationPipe (malformed DTO body → 400 at the edge) + sliding-window login throttle (429 + Retry-After, keyed by socket address); 13/13 acceptance |
| takeover UI | **built + verified in real Chrome**: browser-style tab strip (favicon/title/agent badge, inline release), Fit vs 1:1 zoom, keyboard-focus pill + auto-focus, per-control busy states on Sessions |
| takeover input | **built + verified**: drag-to-select (moves name the held button; press/drag/release tracked on the window so a drag may leave the frame), double/triple-click, full modifier bitmask, and clipboard - Cmd+C/X read the page's selection and land it on the operator's clipboard, Cmd+V inserts via `Input.insertText`, Cmd+A via the `selectAll` editing command. Harness: `run takeover` (8/8) |
| Playwright over `/cdp` | **built + verified**: `connectOverCDP` works end to end - contexts, pages, `goto`/`title`/`textContent`/`evaluate`, `newPage` (leased to its creator), detach + reconnect, two agents concurrently. Mux latches auto-attach itself and synthesizes a per-client replay; self-created targets are adopted into the TabPool; `?compat=1` opts a connection out of `Runtime.enable` suppression (docs site: fidelity). Harness: `run pw` (20/20). **Puppeteer is an explicit non-goal.** |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck` (test: skip - no tests yet; Vitest is wired for when there are)
- push: yes (`origin` = `git@github.com:tobiasstrebitzer/chromatrix.git`); version_bump: no (pre-release, stays 0.1.0 across all packages until told otherwise)
- publish: **CI Trusted Publishing** - bump versions, commit, tag `vX.Y.Z`, push the tag; `publish.yml`
  builds + publishes via OIDC. Do a `/gatekeeper` pass before tagging; confirm the version bump first
- docs: `docs/FINDINGS.md` (public), `_docs/` (internal, gitignored), this CLAUDE.md as index, `apps/docs` public site (GitHub Pages), root + per-package READMEs for the pitch
- frontend_smoke: `pnpm --filter @chromatrix/web run build`, load the served dashboard in real Chrome, assert React mounts with no console errors
- co_authored_by: no (global - `includeCoAuthoredBy: false` in ~/.claude/settings.json)
