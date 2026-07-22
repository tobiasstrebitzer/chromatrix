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
- ~~**Real agent-browser + puppeteer-core through the scoped `/cdp` URL.**~~ **ANSWERED 2026-07-22** on the
  Mac mini (Chrome 150.0.7871.182), and it split:
  - **agent-browser: works, fully.** `connect` to the scoped URL, then `open`, `snapshot -i` (a11y tree with
    `@e1`/`@e2` refs), `click @ref` across a navigation, `eval`, `get text|url`, `screenshot`. Two agents on
    the **same identity** drove two tabs concurrently to different sites with no interleaving.
  - **Playwright + puppeteer-core: broken, both, at target discovery.** Playwright `connectOverCDP` connects
    and `page.goto` succeeds, but `page.textContent` then hangs to timeout; puppeteer `connect` yields
    `browser.pages() === 0`.

  **Root cause: enable-style commands whose entire value is a state *replay* do not survive multiplexing.**
  A raw probe through the scoped URL shows `Target.getTargets` answering correctly and ACL-filtered (it is a
  *query*), while `Target.setDiscoverTargets {discover:true}` returns `{}` and emits **no
  `Target.targetCreated` replay** for the already-existing leased tab. Playwright and Puppeteer both build
  their page registry from that replay, so they see an empty browser and never surface a page.
  agent-browser survives precisely because it uses the query rather than the replay.

  This is the **same class of problem** `runtimeEnableSuppressInterceptor` already solves for `Runtime.enable`
  (packages/fidelity/src/mitigation.ts), and it has the same seam: intercept the enable-style Target commands
  per downstream client and **synthesize the replay** for the targets in that client's scope, rather than
  forwarding to an upstream where the state may already be latched. Worth a puppeteer/playwright regression
  test alongside the fix, since `accept`/`e2e` both drive a bare `CdpClient` and would stay green through
  this bug.

  **ATTEMPTED AND REVERTED 2026-07-22 - read this before trying again.** The obvious fix (mux owns the
  upstream `setDiscoverTargets` enable-state, turned on in the factories before any client attaches;
  `Target.setDiscoverTargets` from a client answered locally with a synthesized `Target.targetCreated` per
  in-scope target) **is necessary but nowhere near sufficient**, and as written it made things worse:

  - It **did** fix the protocol symptom: a raw probe confirmed `Target.targetCreated` now arrives after
    `setDiscoverTargets`, where before it never did. `accept` (13/13) and `e2e` (9/9) stayed green.
  - **puppeteer was unchanged at `browser.pages() === 0`.** Wire trace through a logging relay shows why the
    replay alone does not help - puppeteer's connect handshake is:
    `Target.getBrowserContexts` -> `Target.setDiscoverTargets {discover:true, filter:[{}]}` ->
    `Target.setAutoAttach {autoAttach:true, waitForDebuggerOnStart:true, flatten:true,
    filter:[{type:"page",exclude:true},{}]}`. That filter **excludes page targets from browser-level
    auto-attach**, so no `Target.attachedToTarget` is minted for the leased page, and puppeteer builds its
    Target objects from attach, not from discovery. It then answered `pages()` from memory with no further
    CDP traffic at all.
  - **Playwright got less stable, not more** - it went from "goto works, `textContent` hangs" to
    nondeterministic across runs: `goto` timing out, then `pages()` returning 0 with
    `browserContext.newPage: Cannot read properties of undefined (reading '_page')`.
  - **agent-browser REGRESSED to a hang** (`Failed to read: Resource temporarily unavailable ... daemon may
    be busy or unresponsive`), which is the real reason it was reverted: that is the load-bearing path.
    Likely cause and the **key design constraint for any retry**: `attachClient` wires
    `ws.on('message', (data) => void this.onClientMessage(...))` - **fire-and-forget, not serialized**. Any
    `await` added before `forward()` (the fix awaited an internal `Target.getTargets`) opens a window where
    later messages from the same client are forwarded ahead of earlier ones. A per-client command queue is a
    prerequisite for doing any async work in that path.

  Takeaway: this is not a one-interceptor fix. Framework clients maintain a full target+session state machine,
  and a scoped mux that hides most targets has to emulate that lifecycle coherently (contexts, auto-attach
  filters, attach-on-demand) rather than patch one command. Budget it as a real piece of work with a
  puppeteer + playwright harness written FIRST.
- **HSTS / TLS-session-cache cross-context leak probe** (S3 open item) - only needed if we ever use
  `createBrowserContext` for anonymity.

### API papercuts (found while deploying, 2026-07-22)

- **`allocate-tab` on a stopped identity returns a bare `500`.** The service throws a plain
  `Error("identity \"x\" is not running - startIdentity first")`, which Nest maps to
  `{"statusCode":500,"message":"Internal server error"}` - so the *useful* message only exists in the
  server log and the caller gets nothing actionable. Should be a `409` (or `400`) carrying that text.
- **`start-identity` is not idempotent** - it `409`s when the identity is already running. Defensible,
  but every caller then has to either pre-check `sessions` or swallow the 409, which every script in
  practice does (`>/dev/null 2>&1`). Consider making it idempotent, or documenting the 409 as "already
  up, proceed".

### Prod hardening (deferred to the Mac mini)

- ~~LaunchAgent `KeepAlive` under auto-login~~ **DONE 2026-07-22**: `~/Library/LaunchAgents/bi.atomic.chromatrix.plist`
  on the mini. User agent in `gui/$(id -u)` (headed Chrome needs the Aqua session), runs the gateway
  **from source** via the `@chromatrix/source` condition so a pull needs no build, `KeepAlive` only on
  non-zero exit, `ProcessType Interactive` (Background QoS throttles the Chrome children),
  `ExitTimeOut 30` so SIGTERM can close each Chrome gracefully.
- Attach a display / dummy-HDMI so the GPU engages.
- ~~Tailscale-served endpoints~~ **DONE 2026-07-22**, though *not* by binding `0.0.0.0`: the gateway
  stays on `127.0.0.1:8830` and Caddy fronts it at `https://chromatrix.mini.atomic.bi` (tailnet-only),
  passing the `/cdp` + `/takeover` WS upgrades through. `CHROMATRIX_PUBLIC_ORIGIN=wss://chromatrix.mini.atomic.bi`,
  so minted `cdpUrl`s are drivable from any tailnet device - verified end to end with `agent-browser`
  over `wss`. Keeping the bind on loopback means the token is not the only thing standing between the
  gateway and the LAN.
- ~~Per-identity profile-location strategy (`CHROMATRIX_PROFILES`)~~ **DONE**: `<checkout>/.profiles`,
  set absolutely in the plist.

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
- **Releases now run in CI via npm Trusted Publishing (2026-07-21).** `.github/workflows/publish.yml` fires on a
  `vX.Y.Z` tag push and runs `pnpm publish -r --access public` under OIDC (no `NPM_TOKEN`; provenance is
  generated automatically). Because it uses `pnpm publish` (not `npm publish`), the `workspace:*` gotcha above
  is **dissolved** - pnpm rewrites those to real versions at pack time, so no more pin-publish-revert dance.
  `pnpm publish -r` also skips versions already on the registry, so re-pushing a tag is safe.
- **Release flow:** bump all six package versions (aligned) + root `version`, commit, `git tag vX.Y.Z`, push
  the tag. Prerelease tags (`v0.2.0-rc.1`) publish under the `next` dist-tag. CI (`ci.yml`) lints + typechecks +
  builds on every push/PR to master.
- **One-time npm setup (per package, required before the first CI publish):** on npmjs.com, for EACH of the six
  packages, Settings -> Trusted Publishing -> add a GitHub Actions publisher: repo `tobiasstrebitzer/chromatrix`,
  workflow `publish.yml` (leave environment blank). Until every package has this, its publish step 401s. The
  packages already exist (published via keybridge), so this is additive; keybridge remains the manual fallback.

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
