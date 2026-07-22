---
title: Fidelity
description: What was actually measured - the real Chrome baseline, the one bug fixed, and the compatibility matrix.
---

Fidelity in chromatrix means one thing: a genuine browser presents as what it is. There is no
binary-patching and no fingerprint spoofing. The "hardest to fake" signals are authentic because the
hardware and the browser are real. Everything below was measured on a MacBook Pro (M3 Pro), real Google
Chrome 150, residential IP, and lives on as `pnpm fidelity:check`.

## The through-line

The original worry was that the CDP **automation-protocol fingerprint** - Playwright/Puppeteer's startup
`Runtime.enable` + `Target.setAutoAttach` sequence - would get even legitimate, authorized automation
*falsely* flagged. Two findings reframed that:

1. **On Chrome 150 the classic in-page `Runtime.enable` getter-leak is already closed upstream.**
   `Runtime.consoleAPICalled` now serializes accessor properties as `{type:"accessor"}` without invoking
   the getter. The one clean in-page CDP tell the research relied on is gone here.
2. **A real headed Chrome on macOS with ordinary hygiene behaves like the real browser it is.** It works
   with many anti-bot-protected sites for authorized use.

So the mux's protocol hygiene is now defense-in-depth, not the make-or-break. What buys the most is
authenticity.

## Authentic Apple/Metal WebGL

WebGL reports `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)` - authentic because it *is* a real
Mac's GPU. This is the core reason to run a genuine headed browser on a Mac rather than a headless or
synthetic one; headless/SwiftShader is blocklisted precisely because it isn't real. This requires a
display (or dummy/virtual display) so the GPU engages.

## The one bug found and fixed

A plain `--remote-debugging-port` launch makes Chrome report `navigator.webdriver=true`, which a normal
user's Chrome does not. `--disable-blink-features=AutomationControlled` restores the normal value; it now
ships in `@chromatrix/fidelity`'s launch flags. Do **not** pass `--enable-automation`.

## Compatibility matrix

Measured 2026-07, human-verified where noted. Verdicts vary by IP/geo/day - treat this as a snapshot,
not a guarantee.

| Target | Result |
|---|---|
| x.com `/home` (signed in) | **PASS** - auth cookie + logged-in DOM, persisted across relaunch |
| bot.sannysoft.com | **PASS** - 0 automation mismatches |
| Cloudflare (`nowsecure.nl`, standard) | **PASS** - real content, no challenge |
| DataDome (`leboncoin.fr`) | **PASS** |
| Cloudflare **managed challenge** (Turnstile) | **GATED** - did not auto-clear, by design |

The only case that does not silently clear is the **interactive human-verification challenge** - and that
is correct. A managed challenge is meant to verify a human, so a human completes it via
[takeover](./takeover) and the resulting session persists. chromatrix never auto-solves these.

## Framework-compat mode

Suppressing `Runtime.enable` means Chrome's Runtime domain is never enabled - so it emits **no execution
context lifecycle events at all**. A raw-CDP consumer does not care: it evaluates in the isolated world the
mux hands it. A framework client does, because it tracks a context per world, per frame, per navigation, so
the first navigation strands it on a destroyed context and it hangs.

A connection can therefore opt out, per connection rather than globally:

```
/cdp/<identity>/<agent>?token=…&compat=1
```

or `allocateTab({ compat: true })`, which mints that URL for you. `compat` is not a credential and grants no
extra authority - the per-tab ACL, the derived per-agent token and the leasing model are all unchanged by it.
The only thing it changes is that `Runtime.enable` reaches Chrome.

That is an acceptable trade *on current Chrome specifically*: as measured above, Chrome 150 closed the
in-page getter-trap leak upstream, which makes this suppression defense-in-depth rather than load-bearing.
A client that would otherwise attach to a bare `--remote-debugging-port` Chrome - no mitigation at all, and
no ACL - is strictly better off here. Leave it **off** for clients that do not need it.

## Running the check

```sh
pnpm fidelity:check
```

This runs `@chromatrix/fidelity`'s probes (the `Runtime.enable` getter-trap probe, the WebGL renderer
assertion, the `navigator.webdriver` check) plus the live target matrix. Point it at a specific profile
with `PROFILE_DIR=<abs path>` to test against a signed-in session.
