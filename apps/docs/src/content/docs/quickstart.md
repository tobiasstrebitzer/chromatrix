---
title: Quickstart
description: Boot the gateway, create an identity, and drive a real tab - in a few minutes.
---

## Requirements

- **macOS** with a real Google Chrome install at `/Applications/Google Chrome.app`
- **Node.js ≥ 24**
- A display attached (or a virtual/dummy display) so the GPU engages - chromatrix runs *headed* Chrome

chromatrix is self-hosted software, not a hosted service: you run the gateway yourself. Dev on a
MacBook; keep it running on a Mac mini for prod (see [Deployment](./deployment)).

## Boot the gateway

The published gateway package bundles the dashboard, so this is standalone:

```sh
npx @chromatrix/gateway
```

The gateway boots on `http://127.0.0.1:8830` and prints the access token **once** on first boot (it is
stored in `~/.config/chromatrix/config.json`, mode `0600`). Open the printed URL for the dashboard.

Or run from a checkout:

```sh
git clone https://github.com/tobiasstrebitzer/chromatrix.git
cd chromatrix
pnpm install
pnpm --filter @chromatrix/gateway run start
```

## Create and start an identity

An identity is a named, persistent Chrome profile. Identity ids are lowercase kebab slugs
(`^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars).

```sh
npx @chromatrix/cli create-identity --id work-twitter
npx @chromatrix/cli start-identity --id work-twitter
```

`start-identity` launches a real headed Chrome window for that profile. On the same machine the CLI
finds the gateway automatically; remotely, point it via environment:

```sh
CHROMATRIX_GATEWAY_URL=https://mac-mini.tailnet.ts.net \
CHROMATRIX_TOKEN=… \
npx @chromatrix/cli list-sessions
```

## Sign in once, by hand

For identities that need a login, open **Takeover** in the dashboard and complete the login as a human -
real screencast, real (`isTrusted`) input. The session persists into the identity's profile and survives
restarts. See [Takeover](./takeover).

## Allocate a tab and drive it

```sh
npx @chromatrix/cli allocate-tab --identity work-twitter --agent-id scout --url https://example.com
```

This leases a fresh tab **exclusively** to agent `scout` and returns a scoped CDP WebSocket URL:

```
ws://127.0.0.1:8830/cdp/work-twitter/scout?token=<derived-token>
```

Anything that speaks raw CDP can connect to that URL and drive the tab - while the gateway's per-tab ACL
denies it access to every other agent's tabs. Capture what it sees:

```sh
npx @chromatrix/cli capture-tab --identity work-twitter --target-id <targetId> > shot.jpg
```

## Wire up an agent

Point any MCP client at `http://127.0.0.1:8830/mcp` with `Authorization: Bearer <token>` to get the same
tool surface the CLI uses. MCP is provisioning-only - agents allocate a tab over MCP, then drive raw CDP
over the returned `cdpUrl`. See [Agents & MCP](./agents).
