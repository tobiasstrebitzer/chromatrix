> **Historical document — read with [`PRD.md`](PRD.md) §0.** This is the verbatim original exploratory
> query and the research reply that kicked chromatrix off, kept as a record. Its framing ("stealth mode,"
> "avoid bot detection," "binary-level stealth") reflects that early exploration and the third-party tools it
> surveys (Steel, Patchright, Camoufox — which market themselves that way). The project's actual, governing
> scope is **[`PRD.md`](PRD.md) §0 — Responsible use**: a *real* browser for *authorized* automation
> (browser **fidelity**, not evasion), automating only accounts/sites you own or are permitted to automate,
> respecting ToS/robots/rate limits, with human-in-the-loop for human-verification gates. Where this brief
> says "stealth," read the current intent as "fidelity" within those bounds.

# User Query

Is there a tool / open source project out there that allows me to run headed multi-session and multi-tab browsers on a dedicated device (e.g. mac mini), ideally exposing CDP, compatible with tools like vercel "agent-browser".

What I'm looking for:

1. Chromium based browser, ideally able to host multiple sessions (i.e. different users, signed in to their tools like linkedin, google, etc...).
2. Serving CDP access in a scalable environment. This means that multiple remote agents could trigger jobs at the same time (even for the same "user" / session), so it can open and operate multiple tabs at the same time.
3. Ideally a browser engine that can be configured for a "stealth" mode (ideally real Chrome-like behaviour, including all the tech needed to avoid bot detection)


Dream Screnario:

1. A single App, hosting multiple browser instances (e.g. by session), allowing multiple tabs to work simultaneously.
2. Visually allowing me to introspect, view and "manually control / take over" the different sessions and tabs if needed.

# Agent Reply

Short version: there's no single open-source project that hits all of your requirements at once — persistent multi-identity sessions **and** scalable concurrent CDP **and** binary-level stealth **and** a built-in human-takeover UI. But the space has matured a lot, and the realistic answer is a small composition where **Steel** (self-hosted) is the closest single foundation, with a couple of specific pieces bolted on. Let me also flag two architectural truths that shape everything, because they're easy to miss and will bite you.

## Two constraints that define the design

**One OS process per profile.** Chrome refuses to run two processes against the same `userDataDir`. So "multiple remote agents operating the same signed-in session concurrently" does *not* mean two Chrome processes on one profile — it means **one long-lived Chrome per identity, and concurrency happens as multiple CDP targets (tabs) inside that single browser.** CDP happily multiplexes many attached clients and many targets against one `/devtools/browser/…` endpoint, so N agents opening N tabs on the same logged-in identity works fine. Two processes on the same profile dir does not. Design around "one browser per identity, many tabs," not "many browsers per identity."

**CDP and stealth are in direct tension.** The `Runtime.enable` CDP leak is the single most reliable bot-detection signal in 2025–2026 — and stock Playwright/Puppeteer/agent-browser trigger it by default. So exposing raw CDP and driving heavily over it is exactly what modern anti-bot systems look for, *unless* you patch that leak. This is the crux of your requirement #3.

## The components

**Steel Browser** (`steel-dev/steel-browser`, Apache-2.0) — your closest single fit. It packages Chromium with stealth plugins, fingerprint management, proxy chain support, session persistence, and cookie management, all self-hostable via Docker. You `POST /v1/sessions`, get back a `websocketUrl`, and connect via `browser.connect_over_cdp()` (Playwright) or `puppeteer.connect()` — which is exactly the `wss://…` CDP URL agent-browser now accepts. Each instance is an API exposing CDP plus an Nginx-based UI for interacting with the browser, and Steel ships a live viewer embed for human review. Node + Python SDKs, so it fits your TS stack cleanly.

Steel caveats to weigh: each session runs in an isolated browser context, and concurrency is bounded by RAM at roughly 300–500 MB per active session. Its stealth is plugin/JS-level, not binary-level — fine for moderate anti-bot, weaker against Cloudflare Enterprise / DataDome. And it's architecturally oriented toward session lifecycle more than "20 permanent logged-in identities each with parallel tabs," though profiles give you the persistence primitive to build that.

**Browserless** (OSS Docker + Enterprise) — the other serious self-host option. The open-source image runs Puppeteer/Playwright over WebSocket plus REST; the licensed Enterprise image adds stealth, session recording, an admin UI, and BrowserQL. Note the OSS license: a commercial license is required to run in closed-source commercial environments, and the good stealth is paywalled — so for your stealth requirement it's less attractive than Steel unless you're already paying.

**agent-browser is the consumer, not the server.** It connects to any CDP endpoint — `agent-browser --cdp "wss://…/cdp?token=…"` works with any CDP-compatible service, and it supports headless Chromium, real Chrome with profiles, and remote cloud browsers. So your topology is: `[agent-browser + other agents] → wss CDP → [Steel / your Chrome pool on the Mac mini]`. One current wrinkle worth knowing: as of ~0.20.6 there's an open complaint that remote CDP linking is token-based and the token rotates per browser launch, which complicates static IP:port wiring — check the current release before committing.

**The stealth layer** (for requirement #3, "real Chrome-like"). Since you want CDP *and* stealth, the practical move is real Chrome (headed, real profile, real GPU on the Mac mini — that alone is a big detection win) with the CDP leak patched:
- **rebrowser-patches** — a patch set you apply to Playwright/Puppeteer source; its headline fix is precisely the `Runtime.enable` leak, and it has a marginal edge on Cloudflare Bot Management by more closely mimicking a DevTools-free session.
- **Patchright** — a drop-in pre-patched Playwright fork: `navigator.webdriver` removed, consistent `chrome.runtime`, patched `Runtime.enable` leak, actively tracking upstream. Easiest to adopt.
- **Camoufox** — best raw stealth (C++-level Firefox fork, ~0% headless detection on standard tests), but it's Firefox and not a clean CDP citizen, so it breaks your Chromium+CDP requirement. Mention only as the fallback for the nastiest targets.

One sobering data point on the ceiling here: in a recent benchmark, six Chromium/Firefox stealth approaches failed the same Cloudflare-Turnstile page while Chrome 148 driven over plain CDP with no Playwright passed — i.e., the automation *framework's* fingerprint often matters more than the patches, which is another argument for real Chrome + minimal instrumentation.

**The takeover/introspection layer** (your dream scenario #2). Steel's live viewer covers "watch." For true "grab the mouse and drive it myself," the classic OSS piece is **neko** (`m1k1o/neko`) — a browser-in-a-container streamed over WebRTC with multi-user control handoff. The common DIY pattern: run headed Chrome inside neko's container with `--remote-debugging-port`, agents attach via CDP, and neko gives you the human-viewable + takeover surface on the same live browser. Steel + neko together is the pragmatic way to get both "agents drive it" and "I can take over."

## What I'd actually stand up on the Mac mini

Foundation = **Steel self-hosted** for session management, CDP gateway, and viewer. Per persistent identity, run a long-lived **real Chrome** with a dedicated `userDataDir` and **Patchright or rebrowser-patches** applied for the CDP leak; expose each as a CDP endpoint your orchestrator maps `identity → wss`. Agents (**agent-browser** and others) attach to that wss and open multiple tabs/targets for concurrency. Add **neko** wrapping the headed Chrome when you need full manual takeover beyond Steel's viewer.

If you'd rather not assemble it, the honest tradeoff is that a managed layer (Browserbase/Steel Cloud/Scrapfly) buys you binary-level stealth and the fleet ops you'd otherwise maintain yourself — the recurring theme across every 2026 writeup is that self-hosted stealth is a patch treadmill after each Chrome release.

Want me to sketch the orchestrator — the `identity → Chrome endpoint` mapping, launch flags, and a TypeScript session manager that hands out CDP URLs — as a concrete starting point?