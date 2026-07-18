# chromatrix — next session handoff

Written at the end of the spike phase (2026-07-18). Read [`CLAUDE.md`](../CLAUDE.md) →
[`FINDINGS.md`](FINDINGS.md) → [`PRD.md`](PRD.md) first; this doc is "what to build next and how".

## Where we are

- All four de-risking spikes are **built, run, and green** (S1 mux, S2 stealth+capacity, S3 concurrency,
  S4 takeover). See FINDINGS.md.
- The proven primitives are **consolidated** into `@chromatrix/cdp` (CdpClient, CdpMux, Interceptor +
  transparentInterceptor) and `@chromatrix/stealth` (launchChrome, STEALTH_LAUNCH_FLAGS,
  runtimeEnableSuppressInterceptor). Spike S1 already consumes them via the `@chromatrix/source` dev path.
- Repo: git on `master`, **no remote yet**, 7 commits, whole workspace typechecks + lints clean.
- A real human-verified identity profile exists at `.profiles/x` (x.com, gitignored).

## The next milestone — stand up `apps/gateway` (the real control plane)

This is item **#2** from the end-of-session options: build the gateway on top of the consolidated packages.
NestJS + `@silkweave/nestjs`, per the PRD. **Key constraint (PRD §6):** the CDP WebSocket mux must be mounted
on the underlying `http.Server` Nest wraps, so raw CDP frames bypass Nest's DI/interceptor/guard pipeline;
Nest handles only the management + MCP Action HTTP/MCP endpoints.

Suggested build order (each a small, testable increment):

1. **Scaffold NestJS app** in `apps/gateway` (add `@nestjs/*`, `@silkweave/nestjs`; `tsconfig` with the
   `@chromatrix/source` condition; a `main.ts` that boots Nest on an `http.Server` you also hand to the mux).
   Update `apps/gateway/package.json` (currently a placeholder) — real deps + `dev`/`typecheck` scripts.
2. **`@chromatrix/core` — identity + session domain.** Populate the skeleton:
   - `IdentityRegistry` (id → profileDir), backed by `.profiles/<id>/`.
   - `ChromeSupervisor` — one `launchChrome({ profileDir })` per identity, health check, orphan-tree reaper
     (`pgrep -f user-data-dir`), **single-writer profile lock** (nobody else documents one — we build it; see
     PRD §6/§7 S3).
   - `TabPool` — **exclusive** per-agent tab leasing (S3: tab affinity is mandatory), lease/release, cap per
     identity.
3. **Wire the mux into the gateway.** Mount `CdpMux` (from `@chromatrix/cdp`) on the http upgrade path with
   `runtimeEnableSuppressInterceptor` (from `@chromatrix/stealth`). Hand out **scoped** CDP wss URLs:
   `wss://<host>/cdp/<identity>?token=…`.
4. **Per-tab ACLs** — the genuinely novel bit (only prior art is henu-wang/chrome-mcp-proxy). Extend the mux
   so a client attached to identity X's scope can only see/attach its leased targets, not other agents' tabs.
   This is the main *new* engineering vs. the spikes.
5. **silkweave management/MCP Actions** — `createIdentity`, `listSessions`, `allocateTab` (→ scoped CDP URL),
   `health`, `startTakeover`. MCP surface = **provisioning only** (agents then drive raw CDP; PRD §5).
6. **Takeover endpoint** — promote S4's screencast+input server into a gateway route (and later `apps/web`).

Verify each increment by driving it the way the spikes do (real Chrome, real CDP), not just typecheck.

## Open threads (carry-over)

- **Empirical `cf_clearance` persistence test (high value, quick, needs a human solve).** Launch `pnpm s4` on
  a *real* Cloudflare managed-challenge site (nopecha's demo always re-challenges, so pick a real target,
  ideally from the actual use case), solve the checkbox once by hand, then re-run `pnpm s2:targets` with the
  same `PROFILE_DIR` and watch it flip **GATED → PASS** with `cf_clearance` present. Validates the
  human-assisted-takeover + persistent-session model end-to-end. (See PRD §3/§4 and the Cloudflare Q&A.)
- **Best-effort auto-solve for easy interactive challenges** — curved `mouseMoved` path + dwell + isTrusted
  click on the Turnstile checkbox. Additive, not a silver bullet; falls back to human takeover.
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
  reattaching. `launchChrome` in `@chromatrix/stealth` already does both.
- `navigator.userAgentData` / `deviceMemory` only populate in a **secure (https) context** — probe on https,
  not `about:blank`.
