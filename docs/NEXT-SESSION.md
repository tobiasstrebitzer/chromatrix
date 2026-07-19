# chromatrix — next session handoff

Updated after the dashboard/takeover fix pass (2026-07-19). Read [`CLAUDE.md`](../CLAUDE.md) →
[`FINDINGS.md`](FINDINGS.md) → [`PRD.md`](PRD.md) first (start with **PRD §0 — Responsible use**); this doc is
"what to build next and how".

## Design-system + Sessions UX pass (2026-07-19, later session)

The dashboard was rebuilt visually and the Sessions view became a **management *and* monitoring** surface.
All of it was driven in a real browser via `chrome-devtools-mcp` against real Chrome, not eyeballed in code.

- **Achromatic design system.** Retuned `styles/tokens.css` against the live Vercel dashboard (values pulled
  by evaluating computed styles, not guessed): canvas `#000`, surfaces *lighter* than canvas (`#0a0a0a`),
  hairline `#1f1f1f` borders, 6px radii, 32px controls. **No brand hue** — `--accent` is the inverse of the
  canvas, so a primary button is near-white on dark / near-black on light and **colour means state**. The
  five-stop "chroma" spectrum, the accent glow, and the `Badge` `chroma` variant are all gone.
- **New mark.** A 3×3 grid with the leading diagonal lit — the *identity matrix*. Pure `currentColor`, no
  gradient, no plate, so it inverts with the theme; the favicon carries its own black plate because browser
  chrome isn't ours to theme.
- **Sessions as rows, tabs as cards.** Each identity is a collapsible full-width row (heading + state, with
  Takeover / Health / Stop on the right); expanding shows its tabs as cards carrying a **live screenshot
  refreshed every 5 s**. `about:blank` renders "No URL loaded / inactive" instead of a dead frame; a
  same-sized dashed **"New tab"** placeholder card ends the grid; clicking a thumbnail deep-links to takeover
  **on that tab** (`?target=`, wired through `router.tsx` → `TakeoverView`).
- **Notices split.** Transient confirmations auto-hide; real failures are sticky and dismissible (they used to
  share one red banner that vanished after 3.5 s).

### Still open on the UI

1. **Takeover still looks like a debug tool** — two bare `<select>`s plus a frame count. Wants a real tab
   strip (favicon + title + agent badge, close/release inline), fit-to-width vs 1:1 zoom, and a keyboard-focus
   affordance (today you must click the frame first for keystrokes to land — undiscoverable).
2. **Mutations have a single global `busy` key**, so any in-flight action disables the others and there is no
   per-control spinner. Fine at this fleet size; revisit if it starts to feel laggy.
3. **Empty/edge states** beyond "no sessions" are still thin: identity starting, gateway unreachable mid-poll,
   and "identity in the URL isn't running".
4. **`listSessions` now costs one `Target.getTargets` per identity per poll** (2.5 s) to enrich leases with
   live url/title. Cheap today; if the fleet grows, cache it or push instead of polling.

## Dashboard + takeover fixes (2026-07-19 session)

Everything below was reproduced against real Chrome, fixed, and re-verified end-to-end:

- **No more stray `about:blank` tab.** `launchChrome` always appended a positional URL arg, so every identity
  opened an unleased page target. Now `--no-startup-window` when no `startUrl` is given: browser stays alive,
  DevTools endpoint still printed, **zero** page targets until something leases one (verified headed + headless).
- **Takeover "no visual" — three compounding bugs**, none headless-specific (headless just made it
  deterministic, because a static page never repaints):
  - `Page.screencastFrame` only fires on a *repaint*, so a still page emits one frame and then nothing —
    any viewer joining after it saw an empty `<img>` forever. The hub now caches the last frame and replays
    it to each joining viewer.
  - Start/stop raced: the dashboard unmounts/remounts the viewer on every SPA navigation (twice under
    StrictMode), so the new viewer's start no-op'd against a still-true `casting` flag and the old viewer's
    stop then tore the cast down — connected, "live", permanently blank. Transitions are now serialized.
  - `attachFrontPage` took the first `type === 'page'` from `Target.getTargets`, whose order is unspecified,
    so it could attach to the blank tab. Now prefers a navigated tab, honours the human's pick, and calls
    `Target.activateTarget` (a backgrounded page isn't composited → never repaints).
  - Also: a leaked `Page.screencastFrame` listener per cast cycle, and a hub holding a dead control client
    after stop→start (now rebuilt via `usesClient`/`dispose`). `CdpClient.off` is public for this.
- **Tabs survive a reload.** `listSessions` now returns `leases[]` from the `TabPool` (server is the source of
  truth); the dashboard's local tab state is gone. This required tokens to become **one stable credential per
  `(identity, agentId)`** instead of a fresh one per allocation — otherwise a reconstructed list can't hand
  back a working `cdpUrl` (and the token table grew unboundedly).
- **Tab provisioning UX.** "+ Tab" suggests the next free `agent-N` (was hardcoded `agent-1` whenever the
  field was blank); the optional **start URL** is wired through (backend already supported it).
- **Takeover controls.** Session picker + tab picker. The tab list is pushed over the takeover socket
  (`{type:'targets'}`) and re-pushed on target changes — no polling. Selecting sends `{type:'attach',targetId}`;
  the choice is sticky across re-attaches. Verified input lands on the *selected* tab and leaves others alone.
- **Graceful no-tab state.** Removing the stray tab means a fresh identity has nothing to view; the hub sends
  `{type:'waiting'}` and auto-attaches to the first tab that appears instead of erroring.

## The gateway is built (this session)

`apps/gateway` is a running NestJS control plane, verified end-to-end against real Chrome + real CDP:

- **Boot** — `apps/gateway/src/{main,bootstrap}.ts`: Nest on an `http.Server` we keep a handle to; the raw-WS
  upgrade handler is bound to that server (PRD §6) so CDP frames bypass Nest's DI/guard/interceptor pipeline.
  `.swcrc` added (Nest needs decorator metadata). Deps: `@nestjs/*`, `@silkweave/nestjs` + `@silkweave/mcp`
  (the MCP adapter is an *optional peer* — must be declared explicitly), `class-validator`, `ws`.
- **Mux wiring** — `gateway.service.ts` wraps `@chromatrix/core`'s `Orchestrator`, holds one embedded
  `CdpMux.connect()` per identity (with `runtimeEnableSuppressInterceptor`), and a `token → {identity,agentId}`
  table. `cdp-upgrade.ts` matches `/cdp/<identity>?token=…`, resolves the token, and `attachClient(ws, scope)`s
  the socket. The **scope is derived live** from the `TabPool` (`allows(t)=tabs.isLeasedBy(agentId,t)`), so
  lease/release takes effect immediately — no stored ACL.
- **MCP provisioning surface** — `gateway.controller.ts` (+ `dto.ts`): 8 tools live at `/mcp` — CreateIdentity,
  StartIdentity, StopIdentity, ListSessions, AllocateTab (mints the scoped `…/cdp/<id>?token=…` URL),
  ReleaseTab, Health, StartTakeover. Provisioning-only, per PRD §5.
- **Takeover** — `takeover.ts`: per-identity `TakeoverHub` (S4's screencast fan-out + `Input.dispatch*` promoted)
  on the `/takeover/<id>/ws` raw-WS route, with a viewer page at `GET /takeover/<id>`.
- **Acceptance test** — `src/acceptance.ts` (`pnpm --filter @chromatrix/gateway run accept`): provisions an
  ephemeral identity, allocates a tab for agent A and B, connects a raw `CdpClient` to A's scoped URL, and
  asserts A **evaluates JS in its own tab (6×7=42)**, A's `getTargets` is filtered to A's tab only, A **cannot
  attach** to B's target ("not in this client's scope"), and a bad token is refused at the upgrade. **5/5 green.**
- **Bug fixed in `@chromatrix/core`**: the reaper's `pgrep -f --user-data-dir=…` failed on macOS (the leading
  `--` was read as pgrep flags); now uses the `--` option terminator.

## Where we are

- All four de-risking spikes are **built, run, and green** (S1 mux, S2 fidelity+capacity, S3 concurrency,
  S4 takeover). See FINDINGS.md.
- **`@chromatrix/cdp`** — CdpClient, CdpMux, Interceptor + transparentInterceptor, **plus (this session) the
  per-tab ACL: `ClientScope`, an embeddable `CdpMux.connect()` / `attachClient(ws, scope)` path (no self-hosted
  server, for gateway embedding), attach-deny + `Target.getTargets`/target-lifecycle/`attachedToTarget` event
  filtering by lease.** `CdpMux.start()`/`url` still work for spike S1.
- **`@chromatrix/fidelity`** — launchChrome, FIDELITY_LAUNCH_FLAGS, runtimeEnableSuppressInterceptor.
  **Renamed this session from `@chromatrix/stealth`** (dir + package + `STEALTH_LAUNCH_FLAGS`→`FIDELITY_LAUNCH_FLAGS`;
  the `s2-stealth-baseline` spike is now `s2-fidelity-baseline`).
- **`@chromatrix/core`** — **populated this session** (was a skeleton): `IdentityRegistry`, `ProfileLock`
  (single-writer, stale-reclaiming), `reaper` (`pgrep -f user-data-dir`, SIGTERM→SIGKILL), `ChromeSupervisor`
  (lock → reap → launchChrome → control CdpClient → health), `TabPool` (exclusive per-agent leasing, cap),
  `Orchestrator` facade (start/allocateTab/releaseTab/health/listSessions/shutdown). Typechecks; S1 smoke green.
- **Docs reframed** to responsible-use / browser-fidelity framing (PRD §0; FINDINGS + CLAUDE responsible-use
  callouts; the auto-solve-CAPTCHA thread was dropped as an explicit non-goal).
- Repo: git on `master`, **no remote yet**. Whole workspace **typechecks + lints clean**.
- A real human-verified identity profile exists at `.profiles/x` (x.com, gitignored).

## Multi-session parallel e2e test — built (this session)

`apps/gateway/src/e2e-multi.ts` (`pnpm --filter @chromatrix/gateway run e2e`) scales `acceptance.ts` into the
concurrent load shape the platform exists for, and passes against real Chrome. Env-configurable fleet
(`IDENTITIES`×`AGENTS_PER_IDENTITY`×`TABS_PER_AGENT`, default 2×2×1, `HEADLESS=0` to watch); a tmp profiles
root + an in-process `http.Server` serving a per-tab-marked page keep it hermetic. **9/9 checks green** at
2×2×1 **and** at 3×3×2 (9 agents, 18 tabs across 3 Chromes):

- **Parallelism** — all agents driven via `Promise.all`; wall-clock ≪ Σ per-agent durations (ratio **0.29** at
  2×2, **0.12** at 3×3×2), proving the S3 shared-context + tab-affinity model overlaps under load, not serializes.
- **Isolation matrix** — each tab reads back only its own marker; `getTargets` is ACL-filtered per agent; an
  agent is denied attaching to a **peer** agent's tab (same identity) and to a **foreign** identity's tab.
  Holds under 18 simultaneous attaches (the mux's flat-mode `sessionOwner` routing was the thing under test).
- **Live churn** — releasing a tab denies its own agent's re-attach immediately while a bystander is unaffected.
- **Teardown** — after `handle.close()` (SIGTERM per Chrome), `findChromePidsForProfile` → 0 survivors.

Follow-ups if useful: wrap as a Vitest test; add a soak/leak variant (repeat allocate→work→release for N
rounds, assert RAM/pid steady); measure the real per-identity RAM/throughput ceiling on the Mac mini (S2 said
~1.5–2 GB/Chrome — not yet stress-measured with many tabs).

## apps/web dashboard — built (this session)

The React 19 + Vite + Tailwind-v4 dashboard is built on gtm's design system (rebranded: cyan accent + a
"chroma" spectrum mark) and consumes the gateway over tRPC. Verified: typecheck + `vite build` + lint clean,
and it renders in a real headless Chrome with `#root` populated and **zero console errors** (a
launchChrome + CdpClient smoke — dogfooding our own stack).

- **Gateway additions**: `@Controller('api')` + `@Trpc` on every action; `trpc` + `typegen` + `mcp` silkweave
  adapters; `ServeStaticModule` for `apps/web/dist`; a Vite dev-proxy in `bootstrap.ts` (`VITE_DEV_URL`) with
  the raw-WS handler taking a `fallbackUpgrade` for Vite HMR. **Single origin** dev + prod (no CORS). The
  `appRouter.d.ts` is emitted by typegen and committed. Gateway `src/` regrouped into
  `{gateway,cdp,takeover,common,e2e}/` (no longer flat); the e2e drivers now hit `/api/*`.
- **Web layout**: `styles/` (tokens·globals·fonts) · `lib/` (utils·theme·trpc·useGateway·types·
  sessionsContext·usePersistedState) · `components/{brand,shell,ui}` · `views/` (SessionsView·TakeoverView) ·
  `generated/appRouter.d.ts`.
- **Views**: **Sessions** (start identity → lease agent tabs → copy the scoped CDP URL; Health/Stop/Takeover;
  polls `gatewayListSessions`) and **Takeover** (live-view + `Input.dispatch*` over `/takeover/<id>/ws`).

Follow-ups worth doing on the web app next:
- **Drive it in a browser + screenshot the real UI** (this session only asserted no-console-errors, not visual
  correctness). Then flesh out empty/error states and a session auto-refresh indicator.
- Consider a Vitest/Playwright smoke harness so `frontend_smoke` is a committed script, not an ad-hoc one.
- tRPC outputs are typed `unknown` (no response DTOs) → the web app casts in `lib/useGateway.ts`. Add response
  DTOs on the controller if you want end-to-end typed returns.

## Gateway hardening follow-ups (carry-over, when needed)

- A global `ValidationPipe` so the `class-validator` rules on the DTOs actually run (today handlers read the
  body directly; validation is declared but not enforced).
- Auth on `/mcp` + `/trpc` + the provisioning routes (gtm gates `/mcp` at the transport via `mcp({ auth })`);
  currently open on loopback. Add before exposing over Tailscale.
- Token lifecycle: tokens live until `stopIdentity` and are now **one per (identity, agentId)** (stable, so a
  reloaded dashboard can hand back a working `cdpUrl`). Add release/expiry if agents churn a lot.
- ~~**Make a failed `listen` fatal.**~~ **Done** — `main.ts` now exits 1 on a `listen` syscall failure instead
  of letting the resilience net swallow `EADDRINUSE`.

## Open threads (carry-over)

- **Empirical `cf_clearance` persistence test (high value, quick, needs a human solve).** Launch `pnpm s4` on
  a *real* Cloudflare managed-challenge site **for which you have authorization to automate** (nopecha's demo
  always re-challenges, so pick a real target from the actual use case), have a **person** solve the checkbox
  once by hand, then re-run `pnpm s2:targets` with the same `PROFILE_DIR` and watch it flip **GATED → PASS**
  with `cf_clearance` present. Validates the human-in-the-loop-takeover + persistent-session model end-to-end.
  (See PRD §0/§3/§4 and the Cloudflare Q&A.)
- **Human-verification gates stay human (explicit non-goal).** We do **not** build automated solving of
  CAPTCHAs / Turnstile / managed challenges — auto-solving a human-verification gate is exactly the
  "fake a human" behaviour chromatrix excludes (PRD §0). The supported path for any interactive gate is human
  takeover (S4); the value we add is that a human only has to solve it *once* per identity and the session
  then persists.
- **S1 remaining:** per-tab ACL enforcement is **done** (mux + gateway, proven by the acceptance test). Still
  open: drive the *real* agent-browser binary + puppeteer-core through the gateway's scoped `/cdp` URL (harder
  context-bookkeeping compatibility test — the acceptance test uses a bare `CdpClient`, not puppeteer).
- **HSTS / TLS-session-cache cross-context leak probe** (S3 open item) — only needed if we ever use
  `createBrowserContext` for anonymity.
- **Prod hardening (deferred to Mac mini):** LaunchAgent `KeepAlive` under auto-login (headed needs an Aqua GUI
  session), attach a display / dummy-HDMI so the GPU engages, Tailscale-served endpoints, per-identity profile
  location strategy.

## Per-tab viewport control (2026-07-19, later session)

Tabs are now individually sizable, and the mechanism was chosen by measurement rather than by preference.

- **Every tab is its own browser window** (`Target.createTarget { newWindow: true }` in `TabPool.lease`). This
  is what makes viewport a *per-tab* property at all: window bounds are per-window, so tabs sharing a window
  would be forced to share a size.
- **Sized via `Browser.setWindowBounds` + a measured chrome delta.** `setWindowBounds` takes *outer*
  dimensions, so the gateway reads `Browser.getWindowBounds` and `Page.getLayoutMetrics`, computes the delta
  for that specific window, and corrects. One step lands it **exactly** (verified headed and headless). The
  delta is measured, never assumed — it varies with the bookmarks bar, platform and Chrome version.
- **`Page.getLayoutMetrics`, not `Runtime.evaluate`** — nothing observable executes inside the agent's page.
- **Rejected: `Emulation.setDeviceMetricsOverride`.** Measured side by side, it produced `inner 800×600`
  inside `outer 640×480` — a viewport larger than its own window, impossible on real hardware. It's the easy
  path and it is a fingerprinting tell, so it loses on the one axis this project cares most about.
- **Floor: 500×288 content (500×375 outer).** Chrome silently clamps below that. Consequence worth knowing:
  **phone-width viewports are not reachable** without the emulation override we rejected. The API answers with
  the size actually achieved, and the UI surfaces "clamped to …" rather than echoing the request back.
- **Surfaces**: takeover toolbar gets width/height + an auto-fit button that measures the live pane; a global
  default lives in **Settings** (`POST /api/settings/default-viewport`, persisted to `.profiles/settings.json`)
  so it applies to agents allocating over MCP too. Precedence: explicit → global default → Chrome's own.
  With no default set, the *dashboard* sizes new tabs to fill the takeover pane (measured on the takeover view
  and remembered in localStorage; estimated from shell constants before the first visit).

Verified end-to-end in a real browser: exact sizing, honest clamping, per-tab independence through the tab
picker, global default outranking the fit, and `run accept` (5/5) + `run e2e` (9/9) still green with 8 tabs in
8 windows.

## Animated Logo + Takeover controls (2026-07-19)

**Logo** (`components/brand/Logo.tsx`) is now the primary brand asset and is animated by one rAF controller.

- **Why not CSS**: each mode is expressible in CSS, but the *transitions between* them are not — swapping
  `animation-name` snaps the element to the new animation's start value, which is the hard cut we were
  trying to remove. The controller keeps every mode as a continuous target and eases toward it, so
  default → activity → hover blend in any order, mid-flight.
- **The key trick: ease the phase, not the position.** Cell positions are read straight off the ring path.
  Consecutive ring waypoints differ on exactly one axis, so any interpolated point is axis-aligned by
  construction. Easing a *position* toward a moving target would cut corners diagonally; advancing a *phase*
  along that path cannot. Measured: 149/150 frames moving, max step 0.7px, zero diagonal motion (the one
  flagged "violation" was a single frame straddling a corner, ≤0.7px split across both axes).
- **Landing**: when activity ends the orbit runs on to the next *half* revolution rather than stopping
  mid-segment. The two bright diagonal cells are opposite each other, so half a turn restores a visually
  identical grid — bounding the wind-down at ~1.2s instead of a full 2.4s revolution.
- **Modes**: default = opacity shimmer inside per-cell bands (diagonal floor 0.85 vs off-diagonal ceiling
  0.34, so the diagonal can never be flattened); activity = orbit + damped shimmer + a green tint that each
  cell re-rolls on its own clock, so only some are green at a time; hover = 1.15× scale plus a colour that
  keeps re-rolling between greens, the theme foreground and greys (verified: 159 distinct colours on one
  cell over 3s).
- **Activity signal**: `lib/activity.ts` — a module-scope counter, `trackActivity()` wraps every user-initiated
  gateway call. `listSessions` is deliberately **excluded** (2.5s poll would pin it to "busy" forever). There's
  a 450ms visibility floor so a fast mutation doesn't flash for one frame.
- Gotcha: React's `onPointerEnter` is synthesised from delegated `pointerover`, so a dispatched
  `pointerenter` never reaches it. The component uses native listeners — more robust here, and testable.

**Takeover** got the controls it was missing:

- **Tab picker** is now a base-ui `Select` (`components/ui/Select.tsx`, ported from gtm's). A native
  `<select>` can only render one flat string per row, which forced the old `[agent-1] Title` mash-up; the
  popup shows agent badge, page title and URL as three distinct fields.
- **Address field** — `POST /api/tab/navigate` (`Page.navigate`, resolves on *commit*, not load, so a
  never-idle page can't hang it). The screencast contains no browser chrome, so without this a human in
  takeover could watch a tab but never steer it. Bare hostnames get `https://` prefixed.
- **Light mode fix**: the viewer stage was a hardcoded `bg-black/95` — correct only in dark, a hole punched
  through the page in light. Now `--bg-code`, a recessed well in both themes.
- **Blank tabs** render the same "No URL loaded / inactive" state as the Sessions cards, extracted to
  `components/ui/BlankTab.tsx` so the two can't drift.

## Inset shell + icon rail (2026-07-19)

Ported the "inset view" and collapsible icon bar from **gtm** (`/Users/atomic/projects/mini/gtm`, whose
`AppShell`/`Sidebar`/`frame-shine` are the reference implementation).

- **Inset frame.** Root is `bg-sidebar` (the canvas); the top bar + content sit in a `rounded-xl` panel with an
  8px gutter (`p-2 md:pl-0`, so there's a single gutter between rail and panel, not a double one). Verified:
  12px radius, 8px top/right/bottom, 0 between rail and panel.
- **`.frame-shine`** (globals.css) does the panel's fill *and* edge: a transparent 1px border with a 135°
  `--shine` gradient on `border-box` over a `--bg` fill on `padding-box`. `border-image` can't follow rounded
  corners, which is why it's done this way. **Adding a `bg-*` utility to the frame breaks it.**
- **Token polarity flips by theme** — the whole point of the effect. Light: canvas `#f4f4f4`, panel `#fff`.
  Dark: canvas `#131313`, panel `#000` (canvas *lighter* than panel). New tokens: `--shine`, `--frame-shadow`.
- **`SidebarRail`** — the collapsed state is now a 48px icon rail (mark, nav icons, expand at the bottom)
  instead of hiding the nav entirely, so navigation is always reachable. Deliberately a hard component swap,
  not a width transition: at 48px the labels have nowhere to go and animating just clips them mid-flight.
- **Header alignment.** Both sidebar and rail offset their header row by `mt-[9px]` — the frame's 8px margin
  plus its 1px border — so the wordmark optically centres on the framed top bar. In the full sidebar the link
  carries `pl-1.5` so the 16px mark lands on the same 18px optical line as the nav icons (verified: both at
  x=18; in the rail both centre on x=24).
- **Gotcha: `shadow-(--frame-shadow)` silently produced a transparent shadow.** Tailwind composes shadows
  through `--tw-shadow`, and our token resolved to nothing (the light value is itself a `var()` indirection).
  The frame's `box-shadow` is now declared inside `.frame-shine`. Computed check is the only way to catch
  this — it looks fine until you diff it against the reference.

## Toasts (2026-07-19)

`sonner` added to `apps/web` — the single dependency in an otherwise hand-rolled `ui/` kit, and the first
Radix-adjacent thing in the project. `components/ui/Sonner.tsx` wraps it and is mounted once in `App.tsx`,
outside the router so a toast survives the navigation that may follow the mutation which fired it.

- **Themed via CSS custom properties, not a `theme` prop.** shadcn's wrapper reads next-themes; we have no
  such thing — `lib/theme.ts` flips a DOM attribute and holds no React state. Pointing sonner's
  `--normal-bg`/`--normal-text`/`--normal-border` at our tokens means toasts re-theme automatically with
  `[data-theme]`, with nothing to keep in sync. Verified in both themes: dark `#0a0a0a`/`#ededed`/`#292929`,
  light `#fafafa`/`#171717`/`#e0e0e0`, 6px radius, Inter 13px, bottom-right.
- **Where it's used:** transient confirmations in Sessions (start/stop/health), the viewport clamp notice and
  resize errors in Takeover (which un-overloads the toolbar's status text), and Settings save/clear.
- **Where it is deliberately NOT used:** a failed mutation in Sessions and "gateway unreachable" remain
  **sticky in-page banners**. Auto-hiding the only explanation of why something didn't work is the failure
  mode toasts are worst at; `Banner` is now danger-only since that's all it's for.
- Testing note: sonner mounts **lazily** — `[data-sonner-toaster]` is absent from the DOM until the first
  toast fires, so "is it mounted?" is not a useful check. Default duration is 4s, which is shorter than
  screenshot round-trip latency when driving via CDP; assert on computed styles rather than trying to catch it
  in a screenshot.

## Gotchas learned in the design pass (2026-07-19)

- **A failed `listen` is now fatal** (`main.ts`), closing the carry-over hardening item. It cost a real
  debugging cycle first: a stale gateway held :8830, the new one logged "started" and served nothing, and the
  *old* build answered every request — which reads exactly like "my code change did nothing".

- **Returning a bare `Buffer` from a Nest handler silently JSON-encodes it.** `/api/tab/screenshot` answered
  `200` with `{"type":"Buffer","data":[…]}` — a valid response no `<img>` can decode. `file -b` on the curl'd
  output is what caught it; `curl -w '%{http_code}'` alone would have reported success. Use `StreamableFile`.
- **`Page.captureScreenshot` works on a backgrounded tab; `Page.startScreencast` does not.** The screencast is
  repaint-driven and needs the page composited (hence `Target.activateTarget` in the takeover path), but a
  one-off capture asks for a fresh raster and returns fine — **verified** on a deliberately backgrounded tab,
  ~13–37 ms, no focus stealing. That difference is what makes a grid of passive thumbnails viable at all.
- **`CdpClient.send` has no timeout**, so any new command path needs its own or a hung page leaks a pending
  promise forever. The screenshot path wraps at 4 s and dedupes concurrent captures per target.
- **An `<img>` whose `src` doesn't change is never re-fetched**, `Cache-Control: no-store` or not — a polled
  thumbnail needs a cache-busting query param or it silently freezes on frame one.
- **Swapping `<img src>` directly strobes.** Decode the next frame into a detached `Image` and swap on load,
  or every tick blanks the whole grid for the duration of the fetch.

## Gotchas learned this session (2026-07-19)

- **`Page.startScreencast` is repaint-driven.** It is not a video stream: a static page yields exactly one
  frame. Any screencast fan-out must cache the last frame for late joiners, or they see nothing.
- **A backgrounded/occluded page is not composited**, so it never repaints and never emits frames — call
  `Target.activateTarget` before casting.
- **React StrictMode double-mounts effects in dev**, so a WS-owning component produces close→open in quick
  succession. Any server-side per-connection state machine must serialize its transitions or it will
  interleave into a live-but-dead state.
- **`Target.getTargets` order is unspecified** — never pick "the first page" and assume it's the real one.
- **Chrome launches a startup window unless told not to.** A positional URL arg (even `about:blank`) creates a
  page target; `--no-startup-window` keeps the browser alive with none and still prints the DevTools endpoint.
- **Stale dev pages are noisy neighbours.** A browser tab left on a killed Vite dev server retries
  `ws://<origin>/` ~1×/s forever; those upgrades hit the gateway and look like phantom app traffic. When a
  console error can't be traced to the bundle, check for another tab before suspecting your own code
  (`grep -c "new WebSocket" dist/assets/*.js` settles it fast).
- **An `EADDRINUSE` at `listen` is swallowed** by the entrypoint's process-level resilience net — the gateway
  logs "started" and serves nothing. Consider making listen failure fatal (see hardening follow-ups).

## Gotchas learned in earlier sessions

- pnpm `--filter <pkg> run <script>` runs with **cwd = the package dir** — pass **absolute** paths for env
  like `PROFILE_DIR`.
- Spikes/apps importing workspace packages at source must run with
  `node --conditions=@chromatrix/source --import @swc-node/register/esm-register` and set
  `customConditions` + `allowImportingTsExtensions` in their tsconfig.
- Close persistent-profile Chrome with **SIGTERM** (flushes cookies); clean stale `Singleton*` before
  reattaching. `launchChrome` in `@chromatrix/fidelity` already does both.
- `navigator.userAgentData` / `deviceMemory` only populate in a **secure (https) context** — probe on https,
  not `about:blank`.
- macOS `pgrep -f` reads a pattern that begins with `--` as its own flags — pass `--` first (`pgrep -f -- <pat>`).
  Fixed in `@chromatrix/core`'s reaper.
- NestJS needs emitted decorator metadata: SWC won't emit it from tsconfig alone, so `apps/gateway` has a
  `.swcrc` with `legacyDecorator` + `decoratorMetadata`. The `@silkweave/nestjs/mcp` adapter dynamically
  imports `@silkweave/mcp` — declare it as a direct dep (it's an *optional* peer of `@silkweave/nestjs`).
- pnpm's dep-status precheck fails the whole `--filter … run` if a transitive postinstall script is
  undecided (NestJS pulls in `@scarf/scarf` telemetry) — decide it in `pnpm-workspace.yaml` `allowBuilds`
  (`'@scarf/scarf': false`).
