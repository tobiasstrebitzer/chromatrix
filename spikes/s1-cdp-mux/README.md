# Spike S1 — Mitigating CDP mux vs the `Runtime.enable` leak

**Research question (docs/PRD.md §7, S1):** the chromatrix gateway must expose raw CDP to unmodified
consumers (e.g. `vercel-labs/agent-browser`) *and* survive Cloudflare/DataDome-class detection. The
dominant 2026 detection signal is the automation-protocol handshake — chiefly `Runtime.enable`, which makes
Chrome serialize console-logged objects and invoke their property getters. Can we neutralise that leak
**at the proxy**, for a consumer we don't control, without breaking the consumer's ability to evaluate JS?

If yes → the gateway can be a transparent-looking raw-CDP endpoint that is nonetheless stealthy.
If no → we pivot to a "stealth-lint / reject-and-upgrade the consumer" model instead of silent rewriting.

## How it works

- `launch-chrome.ts` — launches the real headed Google Chrome (channel=chrome) with a throwaway profile and
  the anti-backgrounding flags; returns the `/devtools/browser` WS endpoint.
- `mux.ts` — `CdpMux`: one upstream WS to Chrome, N downstream clients, per-client command-id remapping,
  event routing by `sessionId`, and a pluggable interceptor over every client→Chrome message.
- `mitigation.ts` — two interceptors:
  - `transparent` — byte passthrough (what Steel/Browserless do) → the **baseline**.
  - `runtime-enable-suppress` — never forwards `Runtime.enable`; instead mints a real **isolated world**
    (`Page.createIsolatedWorld`) and synthesizes the `Runtime.executionContextCreated` event the consumer
    expects, so the consumer can still evaluate while Chrome's Runtime domain is never enabled.
- `consumer.ts` — a naive raw-CDP consumer (stand-in for agent-browser): create tab → attach → `Page.enable`
  → `Runtime.enable` → `Runtime.evaluate('1+1')`.
- `probe.ts` — an **independent** observer connected directly to Chrome that never enables Runtime; it arms
  the classic getter-trap in the page's main world and reports whether the getter fired (the same technique
  as `rebrowser-bot-detector`). This is ground truth, decoupled from how the consumer evaluates.
- `run.ts` — launches Chrome once, A/Bs the two interceptors, runs a 2-consumer multiplex smoke check, and
  prints a verdict.

## Run it

```bash
pnpm install          # from repo root (first time)
pnpm s1               # from repo root  (headed Chrome window appears)
HEADLESS=1 pnpm s1    # headless; the Runtime.enable leak is identical, no visible window
```

## Reading the result

| column | meaning |
|---|---|
| `consumer eval ok` | did the naive consumer successfully evaluate `1+1` through the mux |
| `got ctx` | did the consumer receive an execution context to evaluate in |
| `Runtime.enable→Chrome` | did `Runtime.enable` actually reach Chrome (mux ground-truth) — **the protocol claim** |
| `legacy getter-leak` | did the classic console-getter trap fire (informational; closed on Chrome 150+) |

## Recorded result (Chrome 150.0.7871.127, 2026-07)

```
interceptor              consumer eval ok  got ctx  Runtime.enable→Chrome  legacy getter-leak
transparent              yes               yes      YES (reached)          not present
runtime-enable-suppress  yes               yes      no (blocked)           not present
Multiplex smoke: PASS
```

**Two findings:**

1. **The classic in-page getter-trap leak is CLOSED on Chrome 150.** Even under a transparent proxy with
   `Runtime.enable` active, the getter never fires — `Runtime.consoleAPICalled` now serializes accessor
   properties as `{"name":"id","type":"accessor"}` *without invoking them* (see `src/diag2.ts` output).
   The research (dated, tested Chrome 137–148) expected this variant to still leak; it does not here. The
   one clean, deterministic *in-page* CDP tell for `Runtime.enable` is gone on current Chrome.

2. **The protocol-level mitigation works.** The mux prevents `Runtime.enable` from EVER reaching Chrome for
   an unmodified raw-CDP consumer, while that consumer still gets an execution context and evaluates JS
   (via a synthesized isolated world). So the mux's value on Chrome 150 is **handshake-surface reduction /
   defense-in-depth** (older builds, non-getter tells, the `Runtime.enable`+`Target.setAutoAttach` sequence
   that server-side anti-bots key on) — **not** closing an active in-page leak, because there isn't one to
   close on this build.

**Implication for the gateway:** proxy-side `Runtime.enable` suppression is cheap, transparent to the
consumer, and worth keeping — but it is no longer the make-or-break the PRD feared. The stealth ceiling on
current Chrome is set by *other* signals (TLS/JA3, behavioral, network/IP reputation, the handshake pattern
observed server-side), which is exactly what spike **S2** must measure against LinkedIn/Google/Cloudflare/
DataDome. See `docs/PRD.md` §7.

If a future Chrome re-opens an in-page leak, `src/probe.ts` will catch it and the `legacy getter-leak`
column will flip to `DETECTED`.

## Known limitations (turn-1 scope)

- The consumer is a hand-rolled raw-CDP client, the faithful analogue of agent-browser's behaviour. A
  follow-up should drive the real `agent-browser` binary and `puppeteer-core` (whose deeper frame/context
  bookkeeping is a harder compatibility test) through the mux.
- Per-tab **ACL enforcement** (client A must not see client B's targets) is not yet enforced — the multiplex
  check only shows two consumers coexisting. ACLs are the next mux increment.
- Leak measurement uses the offline getter-trap (deterministic, no external dependency). Validating against
  the live `bot-detector.rebrowser.net` and a real Turnstile page belongs to S2.
