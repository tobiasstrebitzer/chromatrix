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

A bare CDP client or `agent-browser` works against the scoped URL directly. The gateway:

- suppresses the `Runtime.enable` handshake for unmodified consumers while still handing them an
  execution context (via a synthesized isolated world);
- routes events so the agent sees only its own targets;
- **denies** any attempt to attach to another agent's tab - including a peer under the same identity.

### Playwright

`chromium.connectOverCDP()` is supported, but the tab must be allocated with **`compat: true`**:

```sh
curl -X POST "$GATEWAY/api/tab/allocate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"identity":"work","agentId":"my-job","compat":true}'
```

The returned `cdpUrl` already carries `&compat=1` - drive it as given rather than rebuilding it. From
there `contexts()`, `pages()`, `goto`, `evaluate`, `newPage()` and detach/reconnect all behave normally,
and a page Playwright opens itself is leased to that agent like any other tab.

`compat` opts the connection out of the `Runtime.enable` mitigation, because Playwright tracks an
execution context per world, per frame, per navigation - state that a suppressed Runtime domain never
emits. See [fidelity](./fidelity#framework-compat-mode) for what that trades away (on current Chrome:
very little).

> **Puppeteer is not supported.** Its connect handshake asks for browser-level auto-attach with page
> targets *excluded* and builds its page registry purely from attach events, so it sees no pages through
> a scoped mux. Use Playwright or `agent-browser`.

## Credentials

An agent never holds the operator token. The scoped `/cdp` URL carries a **derived, per-agent** token -
`HMAC(accessToken, identity ‖ agentId)` - which is one-way: an agent can't reverse it into the credential
that could delete every identity. See [Security](./security).
