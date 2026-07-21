---
title: Introduction
description: What chromatrix is, why it runs a real headed Chrome, and the ground rules it is built on.
---

chromatrix is a self-hosted **multi-session, multi-tab headed-Chrome orchestration service** for macOS.
It runs one persistent, **headed** Chrome per "identity" - a named profile with its own cookies and
logins - and hands out exclusive tabs to concurrent remote agents through a **mitigating CDP gateway**.

One line: *one long-lived real Chrome per identity, many concurrent tabs, driven over a CDP gateway that
is safe to expose and presents authentically, with live view and human takeover - for authorized
automation.*

## Responsible use

chromatrix runs a *real* browser so that **authorized** automation behaves authentically - not to conceal
unauthorized activity. Everything else in these docs assumes this:

- **Authorized targets only.** Automate accounts you own or are explicitly permitted to automate. Respect
  each site's Terms of Service, `robots` directives, and rate limits.
- **Not a circumvention tool.** Defeating access controls, ban evasion, credential stuffing,
  ToS-violating scraping, and mass abuse are permanently out of scope.
- **Human-in-the-loop for human checks.** Interactive verification gates (CAPTCHAs, managed challenges)
  are completed by a **person** via [takeover](./takeover) - never auto-solved.
- **Fidelity, not evasion.** There is no binary patching or fingerprint spoofing. The strong signals are
  authentic because the browser and the hardware are real.

## Why a real headed Chrome

Headless Chrome is trivially distinguishable from a real browser: it has no real GPU (SwiftShader is
blocklisted by name) and its automation flags are wrong by default. A real headed Chrome on real Apple
hardware doesn't have to fake anything - WebGL reports an authentic `ANGLE Metal Renderer` because it
*is* one. What buys the most is authenticity, not tricks. See [Fidelity](./fidelity) for what was
actually measured.

## Why a gateway

One real Chrome per identity is only useful if multiple agents can share it *safely*. The gateway is a
CDP multiplexer - not a transparent proxy - that remaps command ids, routes events by session, and
enforces a live per-tab ACL, so agent A can drive its own tab and is denied touching agent B's, even
under the same identity. It also suppresses the classic `Runtime.enable` protocol tell as
defense-in-depth. See [Architecture](./architecture).

## The pieces

| Surface | Who it's for | What it does |
|---|---|---|
| Dashboard | Humans | Every identity and its tabs with live thumbnails, plus takeover |
| Takeover | Humans | See and drive a tab directly - real screencast + `isTrusted` input |
| MCP (`/mcp`) | Agents | Provisioning: identity lifecycle, tab allocation, capture, health |
| Raw CDP (`/cdp/…`) | Agents | The actual browsing, over a scoped per-agent WebSocket |
| CLI | Humans/scripts | Remote control of the gateway; commands derived live from MCP |

One access token gates every surface - see [Security](./security).

## Where to next

- [Quickstart](./quickstart) - boot a gateway and drive your first tab in a few minutes.
- [Architecture](./architecture) - how the gateway, orchestrator, and mux fit together.
- [Agents & MCP](./agents) - wire an LLM agent to chromatrix.
