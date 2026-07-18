# Spike S2 — macOS headed-Chrome stealth + capacity baseline

**Research question (docs/PRD.md §7, S2):** what is our real stealth ceiling and per-tab capacity on a
Mac, running the real headed Google Chrome? This spike covers the parts that **do not need a logged-in
identity**; the logged-in target matrix (LinkedIn/Google) and Cloudflare-Turnstile/DataDome pass-rates are
deferred until spike **S4** provides the manual-login tool.

## Run it

```bash
pnpm s2     # from repo root — a real Chrome window WILL appear (required for the GPU fingerprint)
```

Headed is mandatory: only a real on-screen GPU context yields the authentic Apple/Metal WebGL renderer.
Network is used for the RAM measurement and the secure-context fingerprint page; failures are tolerated.

## Recorded result (MacBook Pro M3 Pro, Chrome 150.0.7871.127, 2026-07)

- **GPU / WebGL — the macOS advantage, CONFIRMED.**
  `UNMASKED_RENDERER = ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)`.
  This is the authentic Apple/Metal renderer that headless/Linux (SwiftShader/LLVMpipe, blocklisted) cannot
  fake — the single hardest fingerprint to spoof, and the core reason to run headed on a Mac.

- **Automation hygiene — one real tell found and fixed.**
  A plain `--remote-debugging-port` launch leaks **`navigator.webdriver = true`** (the AutomationControlled
  blink feature). Adding **`--disable-blink-features=AutomationControlled`** flips it to `false`. After the
  fix, no obvious automation tells remain in the checked signals:
  `webdriver=false`, `userAgentData` brands present (`Chromium 150, Google Chrome 150`), `deviceMemory=16`,
  `window.chrome` present, `platform=MacIntel`, UA is the standard reduced `Intel Mac OS X 10_15_7` string
  (authentic — real Chrome on Apple Silicon reports the same). NB: `userAgentData`/`deviceMemory` are only
  exposed in a **secure context**, so the probe navigates to `https://example.com` first.

- **Occluded-window rendering — flags effective.** With
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-background-timer-throttling`, a fully-occluded window still rendered ~240 frames in 2s (not
  throttled). Hidden/stacked identity windows will keep working — important for a headed fleet.

- **RAM / capacity.** ~**375 MB per active tab** (real sites), ~**1.0 GB per-identity instance base**
  (browser+GPU+network process tree). Fleet math: `identities × base + tabs × perTab`. The v1 target
  (5 identities + 10 tabs) ≈ **8.5 GB** resident — fits 16 GB (tight), comfortable on 32 GB+. Lazy-launching
  identities and discarding idle tabs lowers this substantially.

## Promoted

`--disable-blink-features=AutomationControlled` (proven here) is added to `@chromatrix/stealth`'s flag set.

## Target matrix (logged-in, real targets) — `pnpm s2:targets`

Connects to the already-running, logged-in Chrome from the S4 login tool (via the profile's
`DevToolsActivePort`) and probes real targets in new tabs. Run it while `pnpm s4` is up on that profile:

```bash
PROFILE_DIR=/abs/path/.profiles/x  pnpm s2:targets
# optional harder targets:
CLOUDFLARE_URL=…  DATADOME_URL=…   PROFILE_DIR=/abs/path/.profiles/x  pnpm s2:targets
```

### Recorded result (x.com identity, Chrome 150, 2026-07)

| target | verdict |
|---|---|
| x.com `/home` signed-in (auth_token cookie + logged-in DOM markers) | ✅ SIGNED IN |
| bot.sannysoft.com automation tells | ✅ 0 failed |
| Cloudflare (nowsecure.nl) | ✅ PASS (real content, no challenge) |
| DataDome | ⬜ skipped — set `DATADOME_URL` to a designated target |

**Read:** real headed Chrome on macOS + the promoted stealth flags clears a signed-in x.com session, an
external automation-tell adjudicator, and a standard Cloudflare-protected page **cleanly**. This confirms
the S1-derived thesis: with in-page CDP tells closed on Chrome 150, ordinary hygiene + real hardware is
enough for these targets.

**Honest caveat:** `nowsecure.nl` is a standard Cloudflare page, **not** a hard managed-challenge/Turnstile
gate, and DataDome (the toughest per the research) is unmeasured. Those remain the real ceiling test — plug
a designated Turnstile-gated and DataDome target into `CLOUDFLARE_URL`/`DATADOME_URL` to measure them.
