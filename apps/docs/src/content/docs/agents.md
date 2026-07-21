---
title: Agents & MCP
description: How an LLM agent provisions a tab over MCP and then drives it over raw CDP.
---

chromatrix has two entry paths for agents, and the split is deliberate:

1. **MCP - provisioning only.** An agent calls MCP tools to create/allocate an identity and tab, and gets
   back a scoped CDP URL.
2. **Raw CDP - the actual browsing.** The agent drives that URL directly.

MCP does *not* wrap every click and extract. Keeping all fidelity and protocol logic in one place (the
gateway) - instead of split across a high-level action layer - is what makes the whole system coherent.

## Connecting over MCP

Point any MCP client at the gateway's `/mcp` endpoint, authenticated with the access token:

```
POST http://127.0.0.1:8830/mcp
Authorization: Bearer <token>
```

You get the same tool surface the CLI uses: identity lifecycle, tab allocation, navigation, viewport,
capture, health, and takeover. See the full [MCP tools reference](./mcp-tools).

## The provisioning flow

```text
create-identity   →  registers the identity
start-identity    →  launches its Chrome
allocate-tab      →  leases a tab, returns { cdpUrl, targetId, … }
        │
        ▼
  connect a raw-CDP client to cdpUrl and drive the tab
        │
release-tab       →  frees the tab and shrinks the agent's ACL scope
```

`allocate-tab` returns a **scoped** CDP WebSocket URL:

```
ws://127.0.0.1:8830/cdp/<identity>/<agentId>?token=<derived-token>
```

## Driving raw CDP

Anything that speaks CDP works against the scoped URL - a bare CDP client, `puppeteer-core` via
`connectOverCDP`, or `agent-browser`. The gateway:

- suppresses the `Runtime.enable` handshake for unmodified consumers while still handing them an
  execution context (via a synthesized isolated world);
- routes events so the agent sees only its own targets;
- **denies** any attempt to attach to another agent's tab - including a peer under the same identity.

> Playwright's `connectOverCDP` is low-fidelity (it triggers `Runtime.enable`) and its GUI
> remote-debugging support is fragile on recent Chrome, so treat Playwright as best-effort rather than a
> guarantee. `agent-browser` and `puppeteer-core` are the intended raw-CDP clients.

## Credentials

An agent never holds the operator token. The scoped `/cdp` URL carries a **derived, per-agent** token -
`HMAC(accessToken, identity ‖ agentId)` - which is one-way: an agent can't reverse it into the credential
that could delete every identity. See [Security](./security).
