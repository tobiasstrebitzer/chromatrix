# chromatrix — next session handoff

Updated mid-gateway-build (2026-07-18). Read [`CLAUDE.md`](../CLAUDE.md) → [`FINDINGS.md`](FINDINGS.md) →
[`PRD.md`](PRD.md) first (start with **PRD §0 — Responsible use**); this doc is "what to build next and how".

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

## The next milestone — finish `apps/gateway` (the real control plane)

Build the gateway on top of the now-complete packages. NestJS + `@silkweave/nestjs`, per the PRD.
**Key constraint (PRD §6):** the CDP WebSocket mux must be mounted on the underlying `http.Server` Nest
wraps, so raw CDP frames bypass Nest's DI/interceptor/guard pipeline; Nest handles only the management + MCP
Action HTTP/MCP endpoints. Reference wiring: `~/projects/mini/gtm/apps/server` (`main.ts` + `app.module.ts`
show the `SilkweaveModule.forRoot` + `trpc`/`mcp` adapters + the raw upgrade handler on `getHttpServer()`).

**Done this session (was steps 2 + the mux half of 3/4):**
- ✅ `@chromatrix/core` domain (step 2).
- ✅ The mux's ACL machinery (step 4) + embeddable mode (the `@chromatrix/cdp` half of step 3).

**Remaining, in order (each a small, testable increment):**

1. **Scaffold NestJS app** in `apps/gateway` (add `@nestjs/common|core|platform-express`, `@silkweave/nestjs`,
   `reflect-metadata`, `class-validator`, `class-transformer`; `tsconfig` with `customConditions:
   ["@chromatrix/source"]` + `experimentalDecorators` + `emitDecoratorMetadata` + `useDefineForClassFields:false`;
   a `main.ts` that boots Nest on an `http.Server` you also keep a handle to). Replace the placeholder
   `apps/gateway/package.json` scripts (`dev`/`typecheck` — mirror gtm's `node --conditions=@chromatrix/source
   --import @swc-node/register/esm-register src/main.ts`).
2. **Wire the mux into the gateway.** On the http `upgrade` event, match `/cdp/<identity>?token=…`, resolve the
   token → lease (agentId+identity) via a `CdpGatewayService`, `handleUpgrade` a `ws`, and hand it to that
   identity's `CdpMux.attachClient(ws, scope)`. The **scope** is built from core: `allows(t) =
   tabPool.isLeasedBy(agentId, t)`, `allowedTargets() = tabPool.targetsFor(agentId)`. Use
   `runtimeEnableSuppressInterceptor` on each identity's mux (`CdpMux.connect({ browserWsUrl:
   supervisor.browserWsUrl, interceptor })`).
3. **silkweave management/MCP Actions** — `createIdentity`, `startIdentity`, `listSessions`, `allocateTab`
   (→ mints a token + returns the scoped `wss://…/cdp/<identity>?token=…`), `releaseTab`, `health`,
   `startTakeover`. MCP surface = **provisioning only** (agents then drive raw CDP; PRD §5).
4. **Takeover endpoint** — promote S4's screencast (`Page.startScreencast` q75 ack-throttled) + `Input.dispatch*`
   server into a gateway route driven off `orchestrator.client(id)` (and later `apps/web`).

Verify each increment by driving it the way the spikes do (real Chrome, real CDP), not just typecheck. The
end-to-end acceptance test: provision an **ephemeral** identity, `allocateTab` for agent A and agent B,
connect a raw `CdpClient` to A's scoped URL, evaluate JS in A's tab, and assert A **cannot** attach to B's
target (the mux returns "not in this client's scope").

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
- **S1 remaining:** per-tab ACL enforcement (now folded into gateway step 4); drive the *real* agent-browser
  binary + puppeteer-core through the mux (harder context-bookkeeping compatibility test).
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
