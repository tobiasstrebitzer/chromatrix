# chromatrix — spike findings (consolidated)

One page of "what we actually know" after the S1–S4 spikes. Detail lives in each `spikes/*/README.md`;
the architectural consequences are folded into [`PRD.md`](PRD.md). Dev machine: MacBook Pro **M3 Pro**,
real Google **Chrome 150**, residential IP.

## The through-line

The research feared the `Runtime.enable` CDP getter-leak was the make-or-break stealth risk. **On Chrome 150
it's already closed** — so the mitigating mux is now *defense-in-depth*, and the real stealth ceiling is set
by external signals (TLS/JA3, behavioral, IP reputation, the server-side handshake). Empirically, **real
headed Chrome on macOS + basic hygiene is enough for a lot** (signed-in x.com, DataDome, standard Cloudflare
all cleared); the wall is the **Cloudflare managed challenge / Turnstile**, which is handled by human/assisted
takeover with a persistent `cf_clearance` cookie — not by more stealth patching.

## S1 — mitigating CDP mux (`pnpm s1`)

- **Chrome 150 closed the classic in-page `Runtime.enable` getter-trap leak.** `Runtime.consoleAPICalled`
  now serializes accessor properties as `{type:"accessor"}` **without invoking the getter** (verified in
  `spikes/s1-cdp-mux/src/diag2.ts`). The one clean in-page CDP tell the research relied on is gone here.
- **Proxy-side suppression works.** The mux blocks `Runtime.enable` from ever reaching Chrome for an
  *unmodified* raw-CDP consumer, yet that consumer still gets an execution context and evaluates JS (via a
  synthesized isolated world). Multiplexing two consumers passes.
- **Consequence:** keep the mux (cheap, transparent handshake-surface reduction), but it is not load-bearing
  for stealth on current Chrome.

## S2 — headed stealth + capacity (`pnpm s2`, `pnpm s2:targets`)

- **Apple/Metal WebGL confirmed:** `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)` — the hardest
  fingerprint to fake, and the core reason to run headed on a Mac. Requires headed (headless/SwiftShader is
  blocklisted).
- **One real tell found & fixed:** a plain `--remote-debugging-port` launch leaks `navigator.webdriver=true`;
  `--disable-blink-features=AutomationControlled` fixes it (now in `@chromatrix/stealth` `STEALTH_LAUNCH_FLAGS`).
  Do **not** pass `--enable-automation`.
- **Capacity:** ~375 MB/active tab, ~1.0 GB/identity-instance base → v1 target (5 identities + 10 tabs)
  ≈ **8.5 GB** resident. Fits 16 GB tight, comfortable 32 GB+.
- **Live target matrix (human-verified x.com login):** x.com `/home` **signed in** (auth_token +
  logged-in DOM), bot.sannysoft.com **0 tells**, Cloudflare `nowsecure.nl` **PASS**.
- **Ceiling test (hard targets):** DataDome `leboncoin.fr` **PASS**, standard Cloudflare **PASS**, Cloudflare
  **managed challenge** (nopecha demo) **GATED** (persisted ~45 s). The wall is the managed challenge/Turnstile,
  **not** DataDome — better than the research feared. (Caveat: the nopecha demo always challenges; verdicts
  vary by IP/geo/day.)

## S3 — shared-tab concurrency (`pnpm s3`)

- **Shared context per identity is sound:** 5 concurrent agents, each in its own tab, all completed, all share
  the login cookie, all localStorage writes land. Multi-session CDP is robust.
- **Tab affinity is mandatory:** forcing two agents onto ONE tab breaks the in-flight op
  (`Inspected target navigated or closed`). The orchestrator's tab pool must lease a tab **exclusively**.
- **Ephemeral `createBrowserContext` isolates storage/cookies but does NOT inherit the persistent login** —
  wrong tool for per-job isolation under a logged-in identity. v1 = **shared context + exclusive tab leasing**.
- **Still open:** dynamic HSTS / TLS-session-cache leakage between default and ephemeral contexts (needs a probe).

## S4 — live view + human takeover (`pnpm s4`, `pnpm s4:test`)

- CDP `Page.startScreencast` (JPEG q75, ack-throttled, fanned out to all viewers) + `Input.dispatch*`.
- **Injected input is `isTrusted`** — indistinguishable from a real user (self-test verifies frames flow, a
  click fires the page handler with `isTrusted===true`, and keyboard types into inputs).
- **Used for real:** a human logged into x.com by hand through the viewer; the session **persisted** into
  `.profiles/x` and survived a browser relaunch (SIGTERM cookie-flush + stale-singleton cleanup).
- This is the escape hatch for interactive gates: a human (or later a Turnstile solver) completes the
  challenge via the viewer; the resulting `cf_clearance`/session persists and is shared across the identity's
  agents (per S3) until it expires.

## Cross-cutting design consequences

1. **Gateway = mitigating mux**, but on Chrome 150 the mitigation is defense-in-depth, not the crux.
2. **Stealth ceiling** = external signals; buy the most with real headed Chrome + a stable identity (profile +
   fixed egress IP) + human-assisted takeover for hard gates. `cf_clearance` persistence is the pragmatic
   answer to managed challenges (see NEXT-SESSION for the empirical test still to run).
3. **Concurrency model** = one Chrome per identity (one `--user-data-dir`), shared default context, tab pool
   with **exclusive** per-agent leasing; a single-writer lock per profile.
4. **Persistence** = the platform owns durability via the profile dir; close persistent Chrome with SIGTERM so
   cookies flush; clean stale `Singleton*` locks on reattach.
