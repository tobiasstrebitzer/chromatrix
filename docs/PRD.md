# chromatrix — Preliminary PRD (spike-oriented)

Status: **DRAFT / preliminary.** Purpose is to (1) frame the product, (2) commit the architectural
direction the research supports, and (3) define spikes that de-risk the genuinely uncertain parts
before we lock a v1 build PRD. Sections marked **[OPEN]** need your decision.

Owner: Tobias · Date: 2026-07-18 · Source inputs: `docs/BRIEF.md`, landscape research (2026-07), scoping answers.

---

## 0. Responsible use & scope (non-negotiable)

chromatrix exists to run a **real** browser so that **authorized** automation behaves authentically — not to
conceal unauthorized activity. Every design decision below assumes this and is bounded by it:

- **Authorized use only.** Automate accounts you own or are explicitly permitted to automate; obtain
  authorization before automating against a third-party site. Respect Terms of Service, `robots` directives,
  and rate limits.
- **Not a circumvention tool.** Out of scope, permanently: defeating access controls, ban evasion, credential
  stuffing, ToS-violating scraping, and mass/abusive automation. If a use requires hiding unauthorized
  activity, chromatrix is the wrong tool.
- **Human-in-the-loop for human checks.** Interactive human-verification gates (CAPTCHAs, Cloudflare managed
  challenges) are completed by a person via the takeover UI (§4/S4) — not auto-solved to fake a human.
- **Fidelity, not evasion.** We run the genuine Chrome binary on real hardware and keep the CDP control
  surface clean so legitimate automation isn't *falsely* blocked. There is no binary patching or fingerprint
  spoofing — the strong signals are authentic because the browser and machine are real.

Where older notes in this doc used "stealth / undetectable / survive," read the intent as **browser fidelity
for authorized automation** within the bounds above.

## 1. What chromatrix is

A self-hosted **multi-session, multi-tab headed-Chrome orchestration service** that runs on a Mac
(dev: this MacBook Pro; prod: a dedicated Mac mini on Tailscale). It hosts a small fleet of long-lived,
signed-in browser identities and lets multiple remote agents drive many tabs concurrently over CDP —
while staying as close to "a real person's real Chrome" as possible (because it *is* one), and letting a
human watch or take over any tab.

One-line: **"one long-lived real Chrome per identity, many concurrent tabs, driven over a CDP gateway that is
safe to expose and presents authentically, with live view + human takeover — for authorized automation."**

## 2. Scoping decisions (locked from our Q&A)

| Dimension | Decision | Consequence |
|---|---|---|
| North star | **Concurrency & correctness** of multiplexing (not raw scale) | Invest in a robust CDP gateway + session lifecycle, not horsepower |
| Scale target (v1) | **Small: ≤5 identities, ~10 concurrent tabs** | Fits one Mac's RAM; correctness over throughput |
| Build vs buy | **Own the control plane; reuse Chrome only** | Drive raw Chrome directly; study Steel/Browserless but don't depend on them |
| Browser fidelity | **HIGH — authorized automation must work with Cloudflare/DataDome-class sites without being *falsely* flagged** | First-class constraint; drives the "mitigating gateway" design below. Not for circumventing controls (§0) |
| Identity bootstrap | **Manual one-time login via takeover UI**, profile persists after | Takeover/live-view is a **v1 requirement**, not a nice-to-have |
| Same-identity concurrency | **Shared tabs, orchestrator-managed** (one context per identity, tabs from a pool) | Simpler; jobs share the login. Interference risk to manage in orchestrator |
| Consumers | **agent-browser** (raw CDP) + **custom LLM agents via MCP** | Two entry paths (see §5) — reconcile in [OPEN-1] |
| API surface | Raw CDP wss + session/identity mgmt API + live-view/takeover API | silkweave provides the mgmt/MCP/takeover surface; the CDP mux is bespoke |
| Hardware path | Dev on MacBook Pro → prod on Mac mini + Tailscale | Nothing host-specific hardcoded; launchd/auto-login concerns deferred to prod |
| Egress/IP (v1) | **Straight host IP / Tailscale exit** | No per-identity proxy in v1; add later only if a target demands it |
| Server framework | **NestJS + `@silkweave/nestjs`** | gtm-consistent; CDP mux mounted raw, outside Nest's pipeline (§6) |

## 3. The architectural crux (why this isn't just "Steel but mine")

The research produced one load-bearing finding: **in 2026 the strongest bot-detection signal is the
automation *protocol* fingerprint — Playwright/Puppeteer's startup `Runtime.enable` + `Target.setAutoAttach`
sequence — not JS-level fingerprints.** In a July-2026 benchmark, `nodriver` (plain WebSocket to the
DevTools port, never issuing `Runtime.enable`) was the *only* tool to pass a hard Cloudflare-Turnstile
target, while Patchright, rebrowser-playwright, Camoufox and vanilla Playwright were all blocked.

This collides directly with our requirements: we want to **expose raw CDP** to consumers, and
**agent-browser is not fidelity-aware** (it drives raw CDP and, based on available evidence, does not clean
up the `Runtime.enable` handshake; it also currently shares the default BrowserContext, leaking storage
across sessions — issue #1068). If we hand a naive consumer a raw endpoint, it will emit the exact protocol
sequence that gets even legitimate, authorized automation *falsely* flagged — the outcome our fidelity
requirement (§0) is meant to avoid.

**Therefore the gateway is a *mitigating* CDP mux, not a transparent proxy.** It sits between consumers
and Chrome and actively governs the protocol: intercept/rewrite/deny sensitive commands
(`Runtime.enable`, `Console.enable`, `Emulation.*`), route JS evaluation through isolated worlds, remap
per-client command IDs, and route events by `sessionId` so each agent only sees its own tabs. This is the
single most novel and most valuable thing chromatrix builds — and the #1 spike (§7).

Contrast: Steel and Browserless both do **transparent byte-forwarding** and delegate multiplexing to
Chrome's native multi-client support, injecting their own fingerprint patches on a *separate internal
connection*. We can copy the "separate internal connection for our own control" pattern, but our external
path must be *interception-capable*, which theirs is not.

## 4. Proposed architecture

```
                       ┌────────────────────────────────────────────────┐
   agent-browser ─wss─▶│                                                 │
   (raw CDP)           │        chromatrix GATEWAY  (apps/gateway)       │
                       │  ┌──────────────┐   ┌──────────────────────┐    │
   LLM agent ──MCP────▶│  │ mgmt/MCP API │   │  CDP mux + mitigator │    │──internal CDP──▶ Chrome(identity A)
   (silkweave Actions) │  │ (silkweave)  │   │  · id remap          │    │                  userDataDir A
                       │  │ · provision  │   │  · sessionId routing │    │──internal CDP──▶ Chrome(identity B)
   Viewer/Takeover ───▶│  │ · allocate   │   │  · per-tab ACL       │    │                  userDataDir B
   (apps/web)          │  │ · takeover   │   │  · leak strip        │    │      ...
                       │  └──────────────┘   └──────────────────────┘    │
                       │         └── Orchestrator / Session Manager ──────┤
                       │             · identity registry                  │
                       │             · single-writer profile lock         │
                       │             · tab pool + allocation               │
                       │             · health / orphan-tree reaper         │
                       └────────────────────────────────────────────────┘
```

Core components (map to packages, §6):

- **CDP mux + mitigator** — bespoke WS server. Multiplexes N clients over Chrome's flat-mode sessions,
  remaps per-client command IDs, routes events by `sessionId`, enforces per-tab ACLs, and applies the
  leak-mitigation policy. References to study/fork: `zackiles/cdp-proxy-interceptor` (interception plugin
  model), `henu-wang/chrome-mcp-proxy` (id-remap + sessionId routing + per-agent target scoping).
- **Orchestrator / session manager** — identity registry, one Chrome per `--user-data-dir`, single-writer
  lock per profile, tab pool allocation, health checks, orphaned-Chrome-tree reaper.
- **Browser-fidelity layer** — launch flags (`--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`, App Nap off), the real
  `channel=chrome` binary, and the gateway's protocol hygiene. macOS gives the authentic Apple/Metal
  WebGL renderer + real fonts/pixels — authentic because the hardware and browser are real, not spoofed —
  **provided a display (or dummy HDMI / virtual display) is attached so the GPU engages.**
- **Management/MCP API (silkweave)** — Actions for: create/list identities, start manual-login session,
  allocate a tab / hand out a scoped CDP endpoint, session health, initiate takeover. Exposed over HTTP +
  MCP (and tRPC for streaming). This is where "custom LLM agents via MCP" plug in.
- **Viewer/takeover (apps/web)** — CDP `Page.startScreencast` (JPEG q~75, ack-throttled) + `Input.dispatch*`
  (produces `isTrusted` events). Takeover modeled as **pause → live → resume** to avoid human/agent input
  collisions. WebRTC/neko explicitly *out of scope* for v1 (heavier X11+GStreamer footprint; only needed for
  smooth video/audio or OS-level chrome/dialog interaction).

## 5. Consumers & the two entry paths

1. **Raw-CDP consumers** (agent-browser, optionally Playwright/Puppeteer): connect via
   `wss://<tailscale-host>/cdp/<scope>?token=...`. The gateway hands out a **scoped** endpoint (an identity,
   and a tab/tab-pool ACL), applies leak mitigation, and multiplexes. Note agent-browser passes the token in
   the URL query string; Playwright `connectOverCDP` is low-fidelity, triggers `Runtime.enable`, and breaks
   against Chrome M144+ GUI remote-debugging — so Playwright support is best-effort, not a v1 guarantee.
2. **MCP consumers** (custom LLM agents): call silkweave Actions to *provision/allocate* an identity+tab and
   receive a scoped CDP URL they then drive. **RESOLVED: MCP = provisioning/session management only** — not
   wrapping every click/extract. Agents get a browser via MCP, then drive it over CDP. This keeps all
   fidelity/protocol logic in one place (the gateway) instead of split across a high-level Action layer.

## 6. Tech stack & monorepo (follows the `mini/gtm` conventions)

pnpm 11 workspace, Node 24, ESM everywhere, **Turbo** pipelines, **TS7 / `tsgo`** for typecheck (no `tsc`),
**oxlint only** (no Prettier, no ESLint), **tsdown** for libs, per-package standalone tsconfigs, and the
`@chromatrix/source` export-condition trick for build-free dev source resolution. silkweave consumed as
published `@silkweave/*` packages.

Proposed layout:

```
packages/
  cdp/        @chromatrix/cdp     — CDP client, flat-session mux, id-remap, sessionId routing, interception hooks
  fidelity/   @chromatrix/fidelity — launch flags, leak-mitigation policies, fingerprint hygiene, verification probes
  core/       @chromatrix/core    — domain: identities, sessions, tab pool, profile lock, orchestrator, health
apps/
  gateway/    @chromatrix/gateway — NestJS server: raw-WS CDP mux + silkweave/NestJS mgmt/MCP API
  web/        @chromatrix/web     — React 19 + Vite + Tailwind v4 viewer/takeover SPA
```

**RESOLVED — Server framework: NestJS + `@silkweave/nestjs`** (consistent with mini/gtm). **Constraint:** the
CDP mux must NOT flow through Nest's request pipeline (DI/interceptors/guards add latency and mangle the raw
protocol). Mount the CDP WebSocket-upgrade handler at the **underlying HTTP server** level (the `http.Server`
Nest wraps), so CDP frames are byte/message-forwarded raw while Nest handles only the mgmt/MCP Action HTTP +
MCP endpoints. This mirrors Steel's separation (they used Fastify for the same reason); we just keep the raw
path deliberately outside Nest.

**RESOLVED — CLI deferred** (not in v1). **RESOLVED — add Vitest** as a deliberate deviation from gtm (this
system is too behavior-heavy — fidelity probes, mux correctness, handshake verification — to spike without tests).

## 7. Spike plan (the actual next step)

Four spikes, mapping to the four requirement pillars. Sequence: **S1 + S2 first** (the risky foundation),
then S3, then S4. Each spike has a crisp success gate. Suggested location: `spikes/` (throwaway, not the
final package layout).

> **S1 status (2026-07-18): first cut BUILT & RUN — see `spikes/s1-cdp-mux/`.** Two findings on the real
> Chrome 150 binary: (1) the classic in-page `Runtime.enable` **getter-trap leak is already CLOSED on Chrome
> 150** — `consoleAPICalled` serializes accessors as `{type:"accessor"}` without invoking them (verified via
> `diag2.ts`); the research's expectation that this variant still leaks was based on older builds (137–148).
> (2) The **protocol-level mitigation works**: the mux provably prevents `Runtime.enable` from ever reaching
> Chrome for an *unmodified* raw-CDP consumer while that consumer still gets a context and evaluates JS (via
> a synthesized isolated world); 2-consumer multiplex passes. **Reframing:** proxy-side suppression is cheap,
> transparent, and worth keeping as **handshake-surface reduction / defense-in-depth** — but it is *not* the
> make-or-break the PRD feared, because there is no active in-page leak to close on current Chrome. The real
> fidelity ceiling is now set by other signals (TLS/JA3, behavioral, IP reputation, the server-side-observed
> handshake), which **S2** must measure. Remaining S1 work: per-tab ACL enforcement; drive the real
> agent-browser binary + puppeteer-core through the mux (harder context-bookkeeping compatibility test).

### S1 — Mitigating CDP mux/gateway  *(highest risk, highest value)*
**Question:** Can a TS proxy sit in front of Chrome's `/devtools/browser` endpoint and let an *unmodified*
raw-CDP consumer (agent-browser) present authentically — specifically clean up the `Runtime.enable`
handshake and route evaluation through isolated worlds, so authorized automation isn't *falsely* flagged —
while correctly multiplexing multiple clients?
**Build:** minimal WS proxy; flat-mode session handling; per-client command-ID remap; event routing by
`sessionId`; an interception layer that denies/rewrites `Runtime.enable`/`Console.enable`. Study/fork
`zackiles/cdp-proxy-interceptor` + `henu-wang/chrome-mcp-proxy`.
**Success gate:** `rebrowser-bot-detector` (bot-detector.rebrowser.net) reports **no** Runtime.enable leak
when the page is driven end-to-end by agent-browser *through the gateway*, and two agents can each drive
their own tab on one browser without seeing each other's targets. **Open risk to resolve here:** whether we
can transparently rewrite an external consumer's `Runtime.enable` into isolated-world evaluation *without
breaking that consumer's expectations* — if not, the fallback is a "fidelity-lint" that rejects/upgrades
consumers rather than silently rewriting.

> **S2 status (2026-07-18): no-login baseline BUILT & RUN — see `spikes/s2-fidelity-baseline/`** (MacBook
> Pro M3 Pro, Chrome 150). ✅ Authentic Apple/Metal WebGL confirmed (`ANGLE (Apple, ANGLE Metal Renderer:
> Apple M3 Pro)`) — the core macOS-headed advantage. ⚠→✅ Found and fixed a real tell: plain launch leaks
> `navigator.webdriver=true`; `--disable-blink-features=AutomationControlled` fixes it (now promoted into
> `@chromatrix/fidelity`). ✅ Anti-backgrounding flags keep occluded windows rendering (~240 frames/2s). ✅
> Capacity: ~375 MB/tab, ~1.0 GB/identity-instance base → v1 target (5 identities + 10 tabs) ≈ 8.5 GB (fits
> 16 GB tight, comfortable 32 GB+).
>
> **Target matrix RUN (2026-07-18, human-verified x.com login via S4, `pnpm s2:targets`):** ✅ x.com `/home`
> signed in (auth_token + logged-in DOM markers, persisted profile); ✅ bot.sannysoft.com **0** automation
> tells failed; ✅ Cloudflare (nowsecure.nl) PASS (real content, no challenge). This confirms the S1 thesis
> end-to-end: with in-page CDP tells closed on Chrome 150, real headed Chrome + ordinary hygiene clears these
> targets. (LinkedIn dropped as too sensitive; x.com used instead.)
>
> **Compatibility test (protected targets, 2026-07):** ✅ DataDome (leboncoin.fr) PASS; ✅ standard Cloudflare
> (nowsecure.nl) PASS; ⚠ Cloudflare **managed challenge** (nopecha demo) GATED — persisted ~45s, did not
> auto-clear. So the only case that doesn't auto-clear is the interactive human-verification challenge
> (managed challenge/Turnstile), not DataDome. That is the expected and correct outcome: a human-verification
> gate should require a human. Caveats: the nopecha demo always challenges (not a perfect discriminator; test
> a real production target for which you have authorization), and verdicts vary by IP/geo/day. **Design
> consequence:** GATED is not fatal — the S4 takeover tool routes interactive gates to a **human**, who
> completes the challenge via the viewer; the resulting session persists. v1 model = automated for un-gated
> authorized targets, human-in-the-loop takeover for the occasional interactive gate.

### S2 — Headed Chrome fleet + fidelity baseline on macOS
**Question:** What's our real browser-fidelity ceiling and per-tab capacity on this Mac?
**Build:** launch N headed `channel=chrome` instances, distinct `--user-data-dir`, anti-backgrounding flags;
confirm WebGL reports `ANGLE (Apple, ANGLE Metal Renderer: Apple M-series...)`; test occluded/off-screen
window rendering; measure RAM per tab across mixed sites; reap orphan trees via `pgrep -f user-data-dir`.
**Targets (the compatibility set):** LinkedIn, Google (Search/Workspace), a Cloudflare-Turnstile site, a
DataDome site — tested for **authorized** access. Test each **both** via plain-CDP baseline and (once S1
exists) through the mitigating gateway.
**Success gate:** authentic Apple/Metal WebGL fingerprint confirmed; occluded windows keep rendering;
documented RAM/tab numbers and a defensible ≤5-identity/~10-tab capacity budget; and a **measured
compatibility result per target** — i.e. a table of "works / gated / blocked" for each of the four. The gate
is *measurement and documentation*, not "clear all four": the research is explicit that self-hosted browser
fidelity alone is unlikely to clear DataDome-class targets, so a DataDome block is a **scope-informing
finding**, not a spike failure. What we must learn: where the real line is, and whether it lands where your
authorized use cases need it. Interactive human-verification gates are handled by human takeover (S4), not
worked around.

> **S3 status (2026-07-18): BUILT & RUN — see `spikes/s3-concurrency/`.** ✅ Shared-context concurrency is
> sound: 5 concurrent agents each in their own tab all completed, all share the login cookie, all localStorage
> writes land (multi-session CDP robust). ❌ Forcing two agents onto ONE tab breaks the in-flight op
> (`Inspected target navigated or closed`) → **tab affinity is mandatory** (a tab is leased to one agent at a
> time). Shared storage/cookies are last-writer-wins → agents namespace keys, orchestrator owns shared state.
> ✅ Per-job `Target.createBrowserContext` isolates storage/cookies **but an ephemeral context does NOT inherit
> the identity's persistent login** (confirmed) → contexts are the wrong tool for per-job isolation under one
> identity; v1 = **shared context + tab affinity**. Still open: dynamic HSTS / TLS-session-cache leakage
> between default and ephemeral contexts (needs a dedicated probe).

### S3 — Session/identity manager + shared-tab concurrency
**Question:** Does "shared tabs, one context per identity" hold up when 3 agents hit one identity at once —
and what actually breaks (navigation stomping, storage races)? Also spike the *alternative* the brief
flagged: does `Target.createBrowserContext` per-job isolation break the persistent login?
**Build:** identity registry + single-writer profile lock; tab pool allocation; manual-login bootstrap;
concurrency stress (N agents / one identity). Side experiment: ephemeral context per job + cookie injection.
**Success gate:** documented failure modes of shared-tab concurrency + a mitigation (lock granularity / tab
affinity); a clear verdict on whether per-job `createBrowserContext` is worth it given it shares the whole
fingerprint and can't persist. Resolve the flagged unknowns: do **dynamic HSTS / TLS-session caches leak**
between the persistent default context and CDP contexts?

> **S4 status (2026-07-18): BUILT & self-tested — see `spikes/s4-viewer-takeover/`.** CDP
> `Page.startScreencast` (JPEG q75, ack-throttled) fanned out to all viewers + `Input.dispatch*` for control.
> Automated gates pass: screencast frames flow (138/1.5s), injected mouse click fires the page handler with
> **`isTrusted === true`**, injected keyboard types into a focused input; a server smoke confirms the HTTP
> viewer + WS frame bridge. `pnpm s4` runs the interactive login tool (headed Chrome + a local
> `http://127.0.0.1:<port>` viewer you drive by hand); `PROFILE_DIR=…` makes the login persist → a reusable
> identity profile. Human-driven real login (LinkedIn/Google) is the remaining manual step, and it's what
> unblocks the deferred S2 target matrix. Out of scope held: WebRTC/neko, pause→live→resume agent handoff.

### S4 — Viewer / takeover (also the login-bootstrap tool)
**Question:** Is CDP screencast + input-injection good enough for manual login and occasional takeover?
**Build:** `Page.startScreencast` → browser canvas in `apps/web`; forward mouse/keyboard via `Input.dispatch*`
through the gateway; pause→live→resume takeover handshake; verify `isTrusted`.
**Success gate:** an operator can complete a real LinkedIn/Google login by hand through the UI; input is
`isTrusted`; acceptable latency for login-grade interaction; screencast doesn't disrupt a concurrent agent
on another tab.

## 8. Non-goals (v1)

WebRTC/neko streaming; binary-level fingerprint patching (C++ forks); horizontal multi-machine scale;
managed proxy rotation per identity (sticky proxy at launch only, if any); wrapping every browser action as
a high-level MCP tool; Windows/Linux hosts.

## 9. Open questions

Resolved: MCP = provisioning/session-mgmt only · Gateway = NestJS + `@silkweave/nestjs` · CLI deferred ·
Vitest added · S2 targets = LinkedIn + Google + Cloudflare Turnstile + DataDome · Egress = host IP / Tailscale.

Still open (not blocking the spikes):
- **[OPEN-A]** Per-tab ACL granularity — do MCP-provisioned agents get a *single* tab, a *named pool*, or a
  *quota* of tabs per identity? (Affects the mux's authorization model; can be decided after S1.)
- **[OPEN-B]** Profile-lock semantics — is manual takeover allowed to run *concurrently* with agents on the
  same identity (read-only screencast is fine; but does takeover pause all agents)? (Decide during S4.)
- **[OPEN-C]** Where profiles live in prod (local userDataDir on the Mac mini vs snapshot/restore) — deferred
  to the v1 build PRD; irrelevant to spikes since dev is single-host.

## 10. Success criteria for the *whole* preliminary phase

We exit spikes and write the v1 build PRD when: S1 proves (or refutes) transparent leak mitigation for
unmodified consumers; S2 confirms the macOS browser-fidelity ceiling + capacity; S3 gives a defensible concurrency
model; S4 proves manual-login-by-takeover works. If S1 refutes transparent rewriting, the v1 design pivots
to "fidelity-lint / consumer-upgrade" instead of silent mitigation — a fork we want to discover in a spike,
not in production.
