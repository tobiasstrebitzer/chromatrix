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

The four foundational risks were de-risked with runnable spikes (since retired — their primitives are promoted
into `packages/` + `apps/`, their fidelity assertions live on as `pnpm fidelity:check`, and what they proved
is recorded in [`docs/FINDINGS.md`](docs/FINDINGS.md)), the proven primitives live in `packages/`, and
all four client surfaces are built and green: the **gateway** (NestJS + `@silkweave/nestjs`, raw-WS CDP mux
outside Nest's pipeline with a live per-tab ACL, takeover), the **dashboard** (`apps/web`), the **CLI**
(`apps/cli`), and **MCP** for agents. Every surface is gated by a single access token, and the whole thing is
ready to run remotely. What remains is validation + prod hardening — see
[`docs/NEXT-SESSION.md`](docs/NEXT-SESSION.md).

## Docs — read these for context

- [`docs/PRD.md`](docs/PRD.md) — the product & architecture spec. Scoping decisions, the architectural crux
  ("mitigating mux, not transparent proxy"), the component design, and per-spike **status notes with results**.
  **Start here.**
- [`docs/FINDINGS.md`](docs/FINDINGS.md) — one-page consolidated summary of what every spike proved (S1–S4 +
  the compatibility test against protected sites). The fastest way to load "what do we know".
- [`docs/NEXT-SESSION.md`](docs/NEXT-SESSION.md) — the continuation handoff: **open threads only** (validation,
  prod hardening, UI polish) plus the accumulated **gotchas**. Deliberately holds no "what's built" inventory —
  that's the status table at the bottom of this file.
- [`docs/BRIEF.md`](docs/BRIEF.md) — the original research brief that kicked this off.
  (The S1–S4 spikes that de-risked this are retired; their results are consolidated in FINDINGS.md and the
  spike code is recoverable from git history.)

## Layout

```
packages/
  cdp/        @chromatrix/cdp     — CdpClient + CdpMux (id-remap, sessionId routing, Interceptor seam)
  fidelity/   @chromatrix/fidelity — launchChrome + fingerprint-hygiene launch flags + runtimeEnableSuppressInterceptor
  core/       @chromatrix/core    — identity registry, tab pool, profile lock, reaper, supervisor, orchestrator
  shared/     @chromatrix/shared  — config schema (zod) + resolution, access-token primitives. Lean by policy:
                                    zod is the ONLY runtime dep, because the published CLI depends on this
apps/
  gateway/    @chromatrix/gateway — NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + silkweave tRPC/MCP mgmt + takeover
              src/{gateway,auth,cdp,takeover,common,e2e}/ — grouped by concern (not flat)
  web/        @chromatrix/web     — React 19 + Vite + Tailwind v4 dashboard (Sessions + Takeover), achromatic design system, tRPC client
              src/{styles,lib,components/{brand,shell,ui,sessions},views,generated}/
  cli/        @chromatrix/cli     — remote CLI over the gateway's MCP surface via silkweave `cliProxy`.
                                    ~45 lines, NO per-command code: commands are derived from `tools/list`
```

## Toolchain & conventions (mirrors `~/projects/mini/gtm`)

- **pnpm 11** workspace, **Node 24**, ESM everywhere. **Turbo** orchestrates `build`/`typecheck`/`test`/`dev`.
- **TypeScript via `tsgo`** (`@typescript/native-preview`) for typecheck — **no `tsc`**. **oxlint** only (no Prettier/ESLint).
- Libraries build with **tsdown** (ESM + `.d.mts`), **only on prepack/CI** — never in dev.
- **`@chromatrix/source` export condition**: apps (and runnable eval scripts) resolve workspace packages straight to TS source in
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
  (hash history). CSS-variable tokens (light/dark on `data-theme`), `cn()` with an extended tailwind-merge for
  the custom text scale, Inter + JetBrains Mono via `@fontsource`.
- **Inset ("framed") shell** (ported from gtm). The nav sits directly on the app canvas (`--sidebar`); the top
  bar + content live in a rounded, bordered panel inset by an 8px gutter (`p-2 md:pl-0`, `rounded-xl`). The
  panel's fill and its gradient edge come from **`.frame-shine`** in `globals.css` — a transparent 1px border
  with a border-box `--shine` gradient over a padding-box `--bg` fill — so **never put a `bg-*` utility on the
  frame**, it would paint over the gradient. **The canvas/panel polarity flips by theme**: light = bright panel
  on grey; dark = darker panel with the rail raised around it. Collapsing swaps the sidebar for a 48px
  **icon rail** (`SidebarRail`), a hard swap rather than an animated width — labels have nowhere to go at 48px.
- **The Logo is the primary brand asset** (`components/brand/Logo.tsx`) and is driven by a **single rAF
  controller**, not CSS animations — CSS can express each mode but not the moves *between* them (swapping
  `animation-name` snaps to the new animation's start value). Three modes blend continuously: **default**
  (opacity shimmer, diagonal held dominant), **activity** (outer ring orbits clockwise + a drifting green
  tint on some cells), **hover** (1.15× scale, colour re-rolling between greens / foreground / grey).
  **Position is never eased — the *phase* is.** Cell positions are read straight off the ring path, whose
  segments are each axis-aligned, so movement can only be horizontal or vertical; easing a position toward a
  moving target would cut corners diagonally. Activity is fed by `lib/activity.ts` (`trackActivity` wraps the
  gateway mutations; `listSessions` is excluded because it polls).
- **UI dependencies are `sonner` (toasts) and `@base-ui/react` (Select, AlertDialog)** — the same base-ui gtm
  builds on. Destructive confirmations use the **alert**-dialog variant deliberately: it has no click-away or
  pointer dismissal, so an irreversible action can only be resolved by an explicit button.
  The rest of `ui/` stays hand-rolled.
- **Toasts.** `components/ui/Sonner.tsx` themes sonner purely through
  sonner's CSS custom properties pointed at our tokens — **not** via a `theme` prop — so toasts re-theme with
  `[data-theme]` like everything else and there's no second source of truth. Use `toast()` for **transient**
  notifications; failures that a user needs to still read a minute later stay as in-page banners.
- **The design system is deliberately achromatic** (retuned from gtm's cyan-accent system against the Vercel
  dashboard as reference): in dark, an inset panel at `#000` with surfaces *lighter* than it (`#0a0a0a`) on a
  `#131313` canvas; hairline `#1f1f1f` borders, 6px radii, 32px controls, 14px/500 headings. There is **no
  brand hue** — the "accent" is the inverse of the canvas (near-white on dark, near-black on light), so the
  primary action reads as primary by contrast alone and **colour is reserved for state**. A coloured pixel in
  this UI always means something. The one sanctioned exception is the Logo's green, which is confined to
  brand expression (activity tint + hover flare) and is deliberately *not* a design token, so it can't leak
  into the UI proper.
- **One access token gates everything.** There is a single credential for the whole gateway; what varies is
  only how a client can *carry* it, and the transport dictates that — `Authorization: Bearer` for programmatic
  clients, an **HttpOnly cookie** for the dashboard (`<img src>` and `new WebSocket()` cannot set headers), and
  `?token=` on the raw-WS upgrades (no CDP client can set a handshake header). All paths converge on one
  constant-time comparison in `auth/auth.ts`. It is minted on first boot and printed **once**.
  - Guarding is per-surface because the surfaces differ: a global `APP_GUARD` covers `/api/*`; silkweave's
    `auth` gates `/trpc` + `/mcp` **at the transport** (a per-method guard cannot close `tools/list`); and
    `/cdp` + `/takeover` check themselves, because a WS handshake never reaches a Nest guard.
  - `cookieToBearer` bridges the cookie to a bearer header for the silkweave transports, and **must** be
    registered before Nest initialises — see the gotcha in NEXT-SESSION.
- **Agents never hold the operator credential.** `/cdp` uses a *derived* per-agent token,
  `HMAC(accessToken, identity ‖ agentId)` — recomputed, never stored, so it survives a restart and there is no
  token table. It is one-way, which is the whole point: an agent can drive its tabs but cannot recover the
  token that would let it delete every identity. The trade is no per-agent revocation (rotate globally).
- **Config: `~/.config/chromatrix/config.json`, overridden by `CHROMATRIX_*` env** (`_TOKEN`, `_HOST`,
  `_PORT`, `_GATEWAY_URL`, `_PUBLIC_ORIGIN`, `_PROFILES`, `_CONFIG`). Note bare `PORT`/`HOST` are **not** read.
  The file is written `0600` and holds the token; the gateway warns if it is readable beyond its owner.
- Real Chrome binary: `/Applications/Google Chrome.app` (v150). Persistent identity profiles live under
  `.profiles/<id>/` (**gitignored** — contains session cookies). Identity ids are lowercase kebab slugs
  (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64) so they need no escaping as a path segment or a directory name.
- **`chrome-devtools-mcp`** is wired in `.mcp.json`: drive the dashboard in a real browser (navigate,
  screenshot, read the console, evaluate) instead of guessing at UI behaviour. Run the gateway yourself
  (`pnpm dev`) and point it at the gateway origin — that combination is how the takeover bugs were found.

## Running things

```bash
pnpm install
pnpm lint          # oxlint
pnpm typecheck     # turbo → tsgo per package

# fidelity eval (packages/fidelity) — the promoted S1/S2 assertions: WebGL renderer, automation fingerprint,
# Runtime.enable getter-trap, + an optional live anti-bot target matrix (x.com/sannysoft/Cloudflare/DataDome)
pnpm fidelity:check                                          # self-check only (launches a headed Chrome; HEADLESS=1 to hide)
PROFILE_DIR=abs/.profiles/<id> pnpm fidelity:check           # + target matrix vs a signed-in profile (optional CLOUDFLARE_URL/DATADOME_URL)

# gateway (apps/gateway) — the real control plane
pnpm --filter @chromatrix/gateway run start    # boot (CHROMATRIX_PORT=8830; /api, /trpc, /mcp, /cdp/<identity>/<agentId>)
pnpm --filter @chromatrix/gateway run accept   # acceptance test: ACL + the full auth perimeter (HEADLESS=1 for no window)
pnpm --filter @chromatrix/gateway run e2e      # multi-session parallel e2e (IDENTITIES/AGENTS_PER_IDENTITY/TABS_PER_AGENT; HEADLESS=0 to watch)

# dashboard (apps/web)
pnpm dev                                       # dev: Vite (:5181) + gateway proxying to it for HMR — open the gateway origin
pnpm --filter @chromatrix/web run build        # prod build → gateway's ServeStatic serves apps/web/dist on one port

# CLI (apps/cli) — remote client; commands are derived from the gateway's MCP tools, so this list is never stale
pnpm --filter @chromatrix/cli run start -- --help
pnpm --filter @chromatrix/cli run start -- create-identity --id work-twitter
pnpm --filter @chromatrix/cli run start -- capture-tab --identity work-twitter --target-id ABC > shot.jpg
# point it at a remote gateway: CHROMATRIX_GATEWAY_URL=https://mac-mini.tailnet.ts.net CHROMATRIX_TOKEN=…
```

## Status at a glance

| Component | Result |
|---|---|
| S1 mux | Runtime.enable getter-leak already closed on Chrome 150; proxy-side suppression works, consumer still evaluates |
| S2 fidelity | Authentic Apple/M3 Metal WebGL confirmed; fixed `navigator.webdriver` mismatch; ~8.5 GB for v1 fleet; x.com signed-in ✓, DataDome/std-Cloudflare PASS, managed-challenge GATED (→ human takeover) |
| S3 concurrency | shared context + tab affinity is the sound v1 model; ephemeral contexts don't inherit the login |
| S4 takeover | screencast + `isTrusted` input proven; used for a real human x.com login |
| **gateway** | **built + green**: Nest/MCP provisioning (15 tools) + raw-WS CDP mux outside Nest + live per-tab ACL + takeover route; acceptance test proves agent A evaluates in its tab and is **denied** attaching to agent B's target |
| **auth** | **built + verified (10/10 acceptance)**: one access token across `/api` (global guard), `/trpc` + `/mcp` (silkweave, gated at the transport so `tools/list` is closed), and `/takeover` (self-checked — a WS handshake never reaches a guard). `/cdp` uses a **derived** per-agent token, `HMAC(accessToken, identity ‖ agentId)`: one-way, so an agent can't recover the operator credential; recomputed, so no token table and it survives a restart. Dashboard signs in for an **HttpOnly cookie**, bridged to a bearer header for silkweave |
| **config** | **built + verified**: `~/.config/chromatrix/config.json` (zod-validated, `0600`) overridden by `CHROMATRIX_*` env. Token minted on first boot and printed once. Bare `PORT`/`HOST` are no longer read |
| **apps/cli** | **built + verified**: remote CLI over MCP via silkweave `cliProxy` — all 15 commands derived from `tools/list`, **zero per-command code**. Full remote scenario passes (create → start → allocate → navigate → capture → list → delete), including `capture-tab > shot.jpg` yielding a real JPEG via silkweave binary resources |
| **multi-session e2e** | **built + green**: `run e2e` runs a concurrent fleet (verified 3 identities × 3 agents × 2 tabs = 18 tabs) — parallelism (wall ≪ Σ), per-agent marker isolation, same-identity + cross-identity ACL denial, live churn, and zero-survivor teardown all pass |
| **apps/web** | **built + green**: React/Vite/Tailwind-v4 dashboard (Sessions provisioning + Takeover live-view), tRPC client to the gateway; dev-proxy + prod-serve both verified; renders in real headless Chrome with no console errors |
| **design system** | **rebuilt + verified**: achromatic dark/gray system (Vercel-referenced), identity-matrix mark, both themes driven in a real browser |
| **sessions UX** | **rebuilt + verified**: identities as collapsible full-width rows; tabs as cards with live 5s screenshot thumbnails; `about:blank` → "No URL loaded"; new-tab placeholder card; new-session row; thumbnail click deep-links to takeover on *that* tab |
| **session lifecycle** | **built + verified**: create / start / stop / delete are four distinct verbs. `listSessions` enumerates the **registry (disk)** left-joined with running state, so `stopped` is a listed resting state rather than an absence — previously stop erased the row and was indistinguishable from delete. Delete is the only op that destroys durable state (stop → `rm -rf` the profile dir), gated behind a type-the-identity confirm. `createIdentity` rejects an existing id instead of silently adopting its profile |
| **per-tab viewport** | **built + verified**: every tab is its own window (`newWindow`), sized exactly via `Browser.setWindowBounds` + measured chrome delta. Takeover has width/height + auto-fit; global default in Settings (persisted to `.profiles/settings.json`). Floor is 500×288 — Chrome won't go smaller, and we don't fake it with emulation |
| **takeover** | **fixed + verified**: last-frame replay for late joiners, serialized cast start/stop, human-selectable target; session + tab pickers in the dashboard; input proven to drive the *selected* tab |
| **tab lifecycle** | **fixed + verified**: no stray `about:blank` on launch (`--no-startup-window`); leases are server-held so the tab list survives a reload; per-agent stable CDP tokens; optional per-tab start URL |
| **screenshots** | **upgraded + verified**: `/api/tab/screenshot` is a silkweave **binary resource**, so one route serves three shapes — raw `image/jpeg` for the dashboard's `<img src>`, a real MCP `image` block an agent can see, and raw bytes on piped stdout for the CLI. Verified over MCP against real Chrome (valid JPEG magic, 9.7 KB) |

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: skip (no tests yet; Vitest is wired for when there are)
- push: no (no git remote configured)
- version_bump: no (pre-release, private)
- publish: no (all packages private)
- docs: `docs/` folder (PRD, FINDINGS, NEXT-SESSION) with this CLAUDE.md as the index
- frontend_smoke: `pnpm --filter @chromatrix/web run build` then load the gateway-served dashboard in a real headless Chrome and assert React mounts with no console errors (see the session's verify-web smoke); a Vitest/Playwright harness is a future add
- co_authored_by: no (global — `includeCoAuthoredBy: false` in ~/.claude/settings.json)
