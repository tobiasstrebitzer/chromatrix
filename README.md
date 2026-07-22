<div align="center">

<img src="https://raw.githubusercontent.com/tobiasstrebitzer/chromatrix/master/docs/banner.svg" alt="chromatrix: one real Chrome per identity, many concurrent tabs over a mitigating CDP gateway, plus live view and human takeover" width="900">

# chromatrix

**Self-hosted, multi-session, multi-tab headed-Chrome CDP orchestration.**

One long-lived *real* Chrome per identity, many concurrent tabs driven by remote agents over a mitigating
CDP gateway, plus live-view and human takeover.

![macOS](https://img.shields.io/badge/macOS-Mac_mini_%2F_MacBook-black?logo=apple)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-5FA04E?logo=nodedotjs&logoColor=white)
![Chrome DevTools Protocol](https://img.shields.io/badge/CDP-headed_Chrome-4285F4?logo=googlechrome&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-agent_surface-D97757)
![License](https://img.shields.io/badge/license-MIT-blue)

[Documentation](https://tobiasstrebitzer.github.io/chromatrix) ·
[Quickstart](#quickstart-self-hosted) ·
[Architecture](https://tobiasstrebitzer.github.io/chromatrix/docs/architecture) ·
[npm](https://www.npmjs.com/org/chromatrix)

</div>

```
$ npx @chromatrix/gateway
gateway listening on http://127.0.0.1:8830

$ npx @chromatrix/cli create-identity --id work-twitter
$ npx @chromatrix/cli start-identity  --id work-twitter
$ npx @chromatrix/cli allocate-tab    --identity work-twitter --agent-id scout
cdpUrl: ws://127.0.0.1:8830/cdp/work-twitter/scout?token=...
```

## What this is

chromatrix runs one persistent, **headed** Chrome per "identity" (a named profile with its own cookies and
logins) on a Mac, and hands out exclusive tabs to concurrent agents through a **mitigating CDP gateway**, not
a transparent proxy. The gateway multiplexes one upstream Chrome connection into per-agent scoped sessions
with a live per-tab ACL, so agent A can drive its own tab and is denied touching agent B's, even under the
same identity. A **dashboard** shows every identity and its tabs with live thumbnails; **takeover** lets a
human see and drive a tab directly (real CDP screencast + `isTrusted` input), the supported path for
completing an interactive human-verification gate. Agents connect over **MCP**; humans use the CLI or the
dashboard. One access token gates every surface.

> **Responsible use.** chromatrix runs a *real* browser so that **authorized** automation behaves
> authentically, not to conceal unauthorized activity. Automate accounts you own or are permitted to
> automate; respect Terms of Service, `robots`, and rate limits. It is **not** for defeating access controls,
> ban evasion, credential stuffing, ToS-violating scraping, or mass abuse. Interactive human-verification
> gates (CAPTCHAs, managed challenges) are completed by a **human** via takeover, never auto-solved. The
> design goal is *fidelity*: a genuine browser presenting as itself, not evasion.

## Why headed, and why a mux

Headless Chrome is trivially distinguishable from a real browser: no real GPU (SwiftShader is
blocklisted by name), and `navigator.webdriver`/automation flags are wrong by default. A **real headed
Chrome on real hardware** doesn't have to fake anything: on an Apple Silicon Mac, `WebGL` reports an
authentic `ANGLE Metal Renderer`, because it *is* one. chromatrix is built around that: what buys the most is
authenticity, not tricks.

Multiple agents still need to share that one browser safely, which is what the **gateway** is for: a CDP
multiplexer (`@chromatrix/cdp`) that remaps command ids, routes events by session, and enforces a live
per-tab ACL, so a scoped client can evaluate in its own tab but never see or attach to another agent's
target. It also closes the classic in-page `Runtime.enable` protocol tell as defense-in-depth. See the
[documentation](https://tobiasstrebitzer.github.io/chromatrix) for what was actually measured and the full
architecture.

## Quickstart (self-hosted)

chromatrix is self-hosted software, not a hosted service: you run the gateway yourself, on a Mac with a real
Chrome install. Dev on a MacBook; keep it running on a Mac mini for prod.

The published gateway bundles the dashboard, so this is standalone:

```sh
npx @chromatrix/gateway   # boots on :8830, prints the access token once
```

Open `http://127.0.0.1:8830` for the dashboard, or drive it remotely:

```sh
npx @chromatrix/cli create-identity --id work-twitter
npx @chromatrix/cli start-identity  --id work-twitter
CHROMATRIX_GATEWAY_URL=https://mac-mini.tailnet.ts.net CHROMATRIX_TOKEN=... npx @chromatrix/cli list-sessions
```

The CLI has **no per-command code**: every command is derived live from the gateway's MCP `tools/list`, so
it can never drift out of sync with what the gateway actually exposes.

### Agents (MCP)

Point any MCP client at the gateway's `/mcp` endpoint (bearer-token authenticated) to get the same tool
surface the CLI uses: identity lifecycle, tab allocation/navigation/capture, viewport, health, takeover.
MCP is **provisioning-only**: once an agent has a tab, it drives raw CDP directly over the scoped
`/cdp/<identity>/<agentId>` URL `allocate-tab` hands back, authenticated by a token derived from the
operator credential (`HMAC(accessToken, identity || agentId)`) that an agent can never reverse into the
credential that could delete every identity.

## Layout

```
packages/
  cdp/        @chromatrix/cdp      - CdpClient + CdpMux: id-remap, sessionId routing, per-tab ACL, interceptor seam
  fidelity/   @chromatrix/fidelity - launchChrome + fingerprint-hygiene flags + verification probes
  core/       @chromatrix/core     - identity registry, tab pool, profile lock, reaper, supervisor, orchestrator
  shared/     @chromatrix/shared   - config schema (zod) + access-token primitives; the CLI's only dependency
apps/
  gateway/    @chromatrix/gateway  - NestJS: raw-WS CDP mux + per-tab ACL + MCP/tRPC provisioning + takeover
  web/        @chromatrix/web      - React 19 + Vite + Tailwind v4 dashboard (sessions + live takeover)
  cli/        @chromatrix/cli      - remote CLI over the gateway's MCP surface; commands derived from tools/list
  docs/       @chromatrix/docs     - Astro documentation site, deployed to GitHub Pages
```

Each package/app has its own README with the specifics; this one is the map.

## Documentation

Full documentation lives at **[tobiasstrebitzer.github.io/chromatrix](https://tobiasstrebitzer.github.io/chromatrix)**
(built from `apps/docs`). Alongside it:

- [`docs/FINDINGS.md`](docs/FINDINGS.md) - one page of what was actually measured against real Chrome and
  real anti-bot systems, human-verified where it matters.

## Development

```sh
pnpm install
pnpm lint            # oxlint
pnpm typecheck       # turbo -> tsgo per package (no tsc)
pnpm fidelity:check  # headed-Chrome fingerprint self-check (HEADLESS=1 to hide the window)

pnpm --filter @chromatrix/gateway run accept   # ACL + auth-perimeter acceptance test
pnpm --filter @chromatrix/gateway run e2e      # concurrent multi-identity fleet e2e
pnpm --filter @chromatrix/docs run dev         # docs site locally
pnpm dev                                       # gateway + dashboard, Vite HMR
```

pnpm 11 workspace, Node >= 24, ESM everywhere. TypeScript via `tsgo` (no `tsc`), oxlint (no
Prettier/ESLint), libraries build with `tsdown` on `prepack`/CI only; apps resolve workspace packages
straight to source in dev via the `@chromatrix/source` export condition, no build step. Full conventions in
[`CLAUDE.md`](CLAUDE.md).

## Status

The four foundational risks (protocol fingerprint, browser fidelity, shared-tab concurrency, human takeover)
were de-risked with runnable spikes, since retired: their primitives are promoted into `packages/`/`apps/`,
their fidelity assertions live on as `pnpm fidelity:check`, and what they proved is recorded in
[`docs/FINDINGS.md`](docs/FINDINGS.md). All four client surfaces are built and green: the gateway, the
dashboard, the CLI, and MCP for agents.

**AI disclosure:** Claude Code (Anthropic) contributed substantially to this repository. The core protocol
and fidelity claims are backed by runnable, repeatable checks (`pnpm fidelity:check`, the gateway's
`accept`/`e2e` suites) and by human-verified sessions through the takeover UI (a real signed-in x.com login
persisted across a browser relaunch), not by unverified assertions.

## License

MIT
