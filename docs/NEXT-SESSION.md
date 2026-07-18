# chromatrix — next session handoff

Updated after the gateway build (2026-07-18). Read [`CLAUDE.md`](../CLAUDE.md) → [`FINDINGS.md`](FINDINGS.md) →
[`PRD.md`](PRD.md) first (start with **PRD §0 — Responsible use**); this doc is "what to build next and how".

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
- Token lifecycle: tokens currently live until `stopIdentity`; add release/expiry if agents churn a lot.

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

## Gotchas learned this session

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
