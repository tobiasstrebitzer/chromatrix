# chromatrix — spike findings (consolidated)

One page of what the S1–S4 spikes established. Detail lives in each `spikes/*/README.md`; the architectural
consequences are folded into [`PRD.md`](PRD.md). Dev machine: MacBook Pro **M3 Pro**, real Google
**Chrome 150**, residential IP.

## Responsible use (read this first)

chromatrix runs a **real** browser to make **authorized** automation behave authentically — not to conceal
unauthorized activity. The whole system assumes you are automating accounts you own or are explicitly
permitted to automate, on sites where that automation is allowed. Concretely:

- **Authorized targets only.** Automate your own accounts / your own infrastructure, or a third-party site
  you have permission to automate. Respect each site's Terms of Service, `robots` directives, and rate limits.
- **Not for circumvention.** chromatrix is not a tool for defeating access controls, ban evasion, credential
  stuffing, scraping in violation of ToS, or mass/abusive automation.
- **Human-in-the-loop for human checks.** Interactive verification (CAPTCHAs, Cloudflare managed challenges)
  is completed by a *person* through the takeover UI. We do not auto-solve human-verification gates to
  impersonate a human at scale.
- **Fidelity, not evasion.** The point is that a genuine browser presents as what it is. There is no
  binary-patching or fingerprint spoofing; the "hardest to fake" signals are authentic because the hardware
  and browser are real.

## The through-line

Going in, the open worry was that the CDP **automation-protocol fingerprint** — Playwright/Puppeteer's
startup `Runtime.enable` + `Target.setAutoAttach` sequence — would get even legitimate, authorized automation
*falsely* flagged by anti-bot systems, because those systems key on that sequence to catch modified/
instrumented browsers. **On Chrome 150 the classic in-page `Runtime.enable` getter-leak is already closed
upstream**, so the mux's protocol hygiene is now *defense-in-depth / compatibility*, not the crux. Empirically,
**a real headed Chrome on macOS with ordinary configuration hygiene behaves like the real browser it is** —
it works with many anti-bot-protected sites (signed-in x.com, DataDome, standard Cloudflare) for authorized
use. The cases it does **not** silently clear are the **interactive human-verification challenges** (Cloudflare
managed challenge / Turnstile) — and that is correct: those are meant to verify a human, so a human completes
them via takeover and the resulting session persists.

## S1 — mitigating CDP mux (`pnpm s1`)

- **Chrome 150 closed the classic in-page `Runtime.enable` getter-trap leak.** `Runtime.consoleAPICalled`
  now serializes accessor properties as `{type:"accessor"}` **without invoking the getter** (verified in
  `spikes/s1-cdp-mux/src/diag2.ts`). The one clean in-page CDP tell the research relied on is gone here.
- **Proxy-side protocol hygiene works.** The mux blocks `Runtime.enable` from ever reaching Chrome for an
  *unmodified* raw-CDP consumer, yet that consumer still gets an execution context and evaluates JS (via a
  synthesized isolated world). Multiplexing two consumers passes.
- **Consequence:** keep the mux (cheap, transparent handshake-surface reduction), but it is not load-bearing
  on current Chrome — running the genuine browser is what matters.

## S2 — headed Chrome baseline + capacity (`pnpm s2`, `pnpm s2:targets`)

- **Authentic Apple/Metal WebGL confirmed:** `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)` — authentic
  because it *is* a real Mac's GPU. This is the core reason to run a genuine headed browser on a Mac rather
  than a synthetic/headless one (headless/SwiftShader is blocklisted precisely because it isn't real).
- **One realism bug found & fixed:** a plain `--remote-debugging-port` launch makes Chrome report
  `navigator.webdriver=true`, which a normal user's Chrome does not; `--disable-blink-features=AutomationControlled`
  restores the normal value (now in `@chromatrix/fidelity` `FIDELITY_LAUNCH_FLAGS`). Do **not** pass
  `--enable-automation`.
- **Capacity:** ~375 MB/active tab, ~1.0 GB/identity-instance base → v1 target (5 identities + 10 tabs)
  ≈ **8.5 GB** resident. Fits 16 GB tight, comfortable 32 GB+.
- **Live target matrix (human-verified x.com login):** x.com `/home` **signed in** (auth_token +
  logged-in DOM), bot.sannysoft.com **0 automation mismatches**, Cloudflare `nowsecure.nl` **PASS**.
- **Compatibility test against protected sites (2026-07):** DataDome `leboncoin.fr` **PASS**, standard
  Cloudflare **PASS**, Cloudflare **managed challenge** (nopecha demo) **GATED** — did not auto-clear, and
  by design it shouldn't: a managed challenge is a human-verification gate, handled via human takeover
  (S4), not bypassed. (Caveat: the nopecha demo always challenges; verdicts vary by IP/geo/day.)

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
- **Injected input is `isTrusted`** — because it goes through the browser's real input pipeline, the same one
  a physical mouse/keyboard uses (self-test verifies frames flow, a click fires the page handler with
  `isTrusted===true`, and keyboard types into inputs).
- **Used for real:** a human logged into x.com by hand through the viewer; the session **persisted** into
  `.profiles/x` and survived a browser relaunch (SIGTERM cookie-flush + stale-singleton cleanup).
- This is the intended path for interactive gates: **a human** completes the challenge/login via the viewer;
  the resulting session (e.g. `cf_clearance`) persists and is shared across the identity's agents (per S3)
  until it expires.

## Cross-cutting design consequences

1. **Gateway = mitigating mux**, but on Chrome 150 the mitigation is defense-in-depth / protocol hygiene,
   not the crux.
2. **What buys the most is authenticity**, not tricks: a real headed Chrome + a stable identity (profile +
   fixed egress IP) + human takeover for interactive gates. Persisting a human-completed session (e.g.
   `cf_clearance`) is the pragmatic, honest answer to human-verification challenges (see NEXT-SESSION for the
   empirical persistence test still to run).
3. **Concurrency model** = one Chrome per identity (one `--user-data-dir`), shared default context, tab pool
   with **exclusive** per-agent leasing; a single-writer lock per profile.
4. **Persistence** = the platform owns durability via the profile dir; close persistent Chrome with SIGTERM so
   cookies flush; clean stale `Singleton*` locks on reattach.
