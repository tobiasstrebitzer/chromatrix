# chromatrix - next session handoff

**What's built** is in [`CLAUDE.md`](../CLAUDE.md)'s status table - that's the inventory, kept current, and it
is not repeated here. **Why it's built that way** is [`docs/PRD.md`](PRD.md). **What the spikes proved** is
[`docs/FINDINGS.md`](FINDINGS.md).

This file is only the forward-looking part: what's still open, and the hard-won details that would otherwise
cost a debugging cycle to rediscover.

---

## Open threads

### Validation (highest value, needs a human)

- **Empirical `cf_clearance` persistence test.** Now run through the real product (the standalone S4/S2 spike
  tools are retired): boot the gateway (`pnpm --filter @chromatrix/gateway run start`), `create-identity` +
  `start-session`, open **Takeover** in the dashboard on a *real* Cloudflare managed-challenge site **for which
  you have authorization to automate** (nopecha's demo always re-challenges, so pick a real target from the
  actual use case), and have a **person** solve the checkbox once by hand. Then run `pnpm fidelity:check` with
  `PROFILE_DIR=<that identity's .profiles/<id>>` (or `CDP_URL=` the running gateway Chrome) and watch the
  Cloudflare row flip **GATED → PASS** with `cf_clearance` present. Validates the human-in-the-loop-takeover +
  persistent-session model end to end. (PRD §0/§3/§4.)
- **Human-verification gates stay human (explicit non-goal).** We do **not** build automated solving of
  CAPTCHAs / Turnstile / managed challenges - auto-solving a human-verification gate is exactly the "fake a
  human" behaviour chromatrix excludes (PRD §0). The supported path is human takeover (S4); the value we add
  is that a human solves it *once* per identity and the session then persists.
- **Real agent-browser + puppeteer-core through the scoped `/cdp` URL.** Per-tab ACL enforcement is proven,
  but only against a bare `CdpClient`. Puppeteer does much heavier context bookkeeping, so it is a genuinely
  different compatibility test.
- **HSTS / TLS-session-cache cross-context leak probe** (S3 open item) - only needed if we ever use
  `createBrowserContext` for anonymity.

### Prod hardening (deferred to the Mac mini)

- LaunchAgent `KeepAlive` under auto-login (headed Chrome needs an Aqua GUI session).
- Attach a display / dummy-HDMI so the GPU engages.
- Tailscale-served endpoints; bind `CHROMATRIX_HOST=0.0.0.0` and set `CHROMATRIX_PUBLIC_ORIGIN` to the
  `wss://…` tailnet name so minted `cdpUrl`s are reachable.
- Per-identity profile-location strategy (`CHROMATRIX_PROFILES`).

### Gateway follow-ups

- The takeover socket accepts `?token=` for non-browser viewers, which puts a credential in a query string.
  Nothing logs it today - keep it that way, and prefer the cookie path.

### UI

1. **Empty/edge states** beyond "no sessions" are thin: identity starting, gateway unreachable mid-poll, and
   "identity in the URL isn't running".
2. **`listSessions` costs one `Target.getTargets` per identity per poll** (2.5 s) to enrich leases with live
   url/title. Cheap today; cache or push if the fleet grows.

### Publishing (2026-07-21)

- **All six packages are LIVE on npm at 0.1.0** (public, MIT, under the `chromatrix` org): `@chromatrix/shared`,
  `cdp`, `fidelity`, `core`, `cli`, `gateway`. Published via keybridge after a `/gatekeeper` pass.
- **Publishing gotcha - keybridge shells out to `npm publish`, and npm does NOT rewrite `workspace:*`** (that's
  a pnpm/yarn behaviour). Publishing a manifest with `workspace:*` ships it literally and the package is
  uninstallable. The first publish worked around it by temporarily pinning the four affected manifests
  (`core`, `fidelity`, `cli`, `gateway`) to `0.1.0`, publishing, then reverting manifest + lockfile (a pnpm
  run during prepack absorbs the pins into `pnpm-lock.yaml` - revert that too). Future releases: either repeat
  the pin-publish-revert dance, or move to `pnpm publish` / CI Trusted Publishing which rewrite correctly.
- **CI: GitHub Actions + npm Trusted Publisher.** Queue a release workflow (build → typecheck → test → publish
  via OIDC Trusted Publishing, no long-lived npm token in CI) - this also dissolves the workspace-protocol
  gotcha above if the workflow publishes with pnpm.

---

## Gotchas

Durable, expensively-learned details. Roughly grouped; all still current.

### Auth & config

- **silkweave's auth reads `Authorization: Bearer` and nothing else.** The dashboard can only present an
  HttpOnly cookie, so `/trpc` and `/mcp` 401 for the browser unless something bridges the two. `cookieToBearer`
  does that - same credential, different carrier.
- **`app.use()` after `NestFactory.create()` runs too late.** The silkweave adapters mount their `/trpc` and
  `/mcp` handlers *during* `create`, so middleware registered afterwards never sees those routes. The gateway
  therefore constructs its own Express instance and registers the bridge before Nest initialises. Symptom if
  you get this wrong: `/api` authenticates fine and `/trpc` does not.
- **A WebSocket handshake never reaches a Nest guard.** Upgrades arrive on the http.Server's `upgrade` event;
  Express - and every guard, pipe, and interceptor - is mounted on `request`. `/cdp` and `/takeover` must
  authenticate themselves, which is also why they can reject with a real `HTTP/1.1 401` before accepting.
- **A derived token cannot be reversed**, so the client has to name its agent (`/cdp/<identity>/<agentId>`)
  and the HMAC proves the claim.
- **Env vars are `CHROMATRIX_*`-prefixed** - bare `PORT`/`HOST` are *not* read. Config file first,
  environment overrides.

### CDP

- **`Page.captureScreenshot` works on a backgrounded tab; `Page.startScreencast` does not.** The screencast is
  repaint-driven and needs the page composited (hence `Target.activateTarget` in the takeover path), but a
  one-off capture asks for a fresh raster and returns fine - verified on a deliberately backgrounded tab,
  ~13-37 ms, no focus stealing. That difference is what makes a grid of passive thumbnails viable at all.
- **`Page.startScreencast` is not a video stream.** A static page yields exactly one frame, so any fan-out
  must cache the last frame for late joiners or they see nothing.
- **`CdpClient.send` has no timeout** - any new command path needs its own, or a hung page leaks a pending
  promise forever.
- **`Target.getTargets` order is unspecified** - never pick "the first page" and assume it's the real one.
- **Chrome launches a startup window unless told not to.** A positional URL arg (even `about:blank`) creates a
  page target; `--no-startup-window` keeps the browser alive with none and still prints the DevTools endpoint.
- Close persistent-profile Chrome with **SIGTERM** (flushes cookies); clean stale `Singleton*` before
  reattaching. `launchChrome` already does both.
- `navigator.userAgentData` / `deviceMemory` only populate in a **secure (https) context** - probe on https,
  not `about:blank`.

### Nest / HTTP

- **oxc does not emit decorator metadata**, so a plain tsdown build of the gateway boots but injects nothing
  and validates nothing - Nest DI and the `ValidationPipe` both read `design:paramtypes`. The gateway's
  `tsdown.config.ts` routes the transform through `unplugin-swc` (same jsc config as `.swcrc`) for exactly
  this reason; if the build ever mysteriously loses validation, check that plugin is still doing the TS.
- **The gateway detects "dev checkout vs npm install" by whether `common/paths.ts` runs from
  `<workspace>/apps/gateway/src`** - not by the presence of `pnpm-workspace.yaml` alone, because an npm
  install can land inside some unrelated monorepo whose workspace root would be mistaken for ours. Checkout:
  `apps/web/dist`, boot-time typegen, `<repo>/.profiles`. Install: bundled `<pkg>/web`, no typegen,
  `~/.local/share/chromatrix/profiles`. Running `node build/main.mjs` inside the repo behaves as an install
  (the bundle lives under `build/`, not `src/`) - that's intended, it's how the packaged shape gets tested.

- **Returning a bare `Buffer` from a Nest handler silently JSON-encodes it** - `200` with
  `{"type":"Buffer","data":[…]}`, which no `<img>` can decode. Use `StreamableFile` with an explicit `type`;
  that also drives silkweave's resource mapping (MCP image block, CLI raw bytes).
- **`curl -w '%{http_code}'` alone would have reported success** on that bug. `file -b` on the output is what
  caught it.
- NestJS needs emitted decorator metadata: SWC won't emit it from tsconfig alone, so `apps/gateway` has a
  `.swcrc` with `legacyDecorator` + `decoratorMetadata`.

### Frontend

- **An `<img>` whose `src` doesn't change is never re-fetched**, `Cache-Control: no-store` or not - a polled
  thumbnail needs a cache-busting param or it silently freezes on frame one.
- **Swapping `<img src>` directly strobes.** Decode into a detached `Image` and swap on load, or every tick
  blanks the grid for the duration of the fetch.
- **React StrictMode double-mounts effects in dev**, so a WS-owning component produces close→open in quick
  succession. Any server-side per-connection state machine must serialize its transitions.

### Environment

- **A stale gateway is the most expensive failure mode here.** `main.ts` now exits 1 on a `listen` failure
  precisely because the alternative - new process logs "started", old process answers everything - reads
  exactly like "my code change did nothing". When something inexplicably ignores your edit, check for a second
  process first (`lsof -nP -iTCP:8830 -sTCP:LISTEN`). Note `pkill -f` patterns must match the *actual*
  command line, which for these is `node … src/main.ts` with no "gateway" in it.
- **Stale dev pages are noisy neighbours.** A tab left on a killed Vite server retries `ws://<origin>/` ~1×/s
  forever; those upgrades hit the gateway and look like phantom traffic.
- **A literal NUL byte in a source file makes it "binary" to grep** - every search over it silently returns
  nothing. Write `\u0000` as an escape. (One had crept into `gateway.service.ts`.)
- pnpm `--filter <pkg> run <script>` runs with **cwd = the package dir** - pass **absolute** paths for env
  like `PROFILE_DIR`.
- Apps (and runnable eval scripts like `pnpm fidelity:check`) importing workspace packages at source must run
  with `node --conditions=@chromatrix/source --import @swc-node/register/esm-register` and set
  `customConditions` + `allowImportingTsExtensions` in their tsconfig.
- macOS `pgrep -f` reads a pattern beginning with `--` as its own flags - pass `--` first. Fixed in the reaper.
- pnpm's dep-status precheck fails the whole `--filter … run` if a transitive postinstall script is undecided
  (NestJS pulls in `@scarf/scarf` telemetry) - decide it in `pnpm-workspace.yaml` `allowBuilds`.
- `@silkweave/nestjs/mcp` dynamically imports `@silkweave/mcp` - declare it as a direct dep (it's an
  *optional* peer).
