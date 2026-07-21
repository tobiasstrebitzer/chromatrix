---
title: MCP tools
description: The provisioning tools the gateway exposes over MCP (and, identically, the CLI).
---

The gateway exposes its management surface as MCP tools at `/mcp`. The [CLI](./cli) derives its commands
from exactly this list, so the two never diverge. Remember the boundary: **MCP provisions; agents then
drive raw CDP** over the URL `allocate-tab` returns (see [Agents & MCP](./agents)).

Every tool is also a REST route under `/api` and a tRPC procedure for the dashboard.

## Identity lifecycle

| Tool | Purpose |
|---|---|
| `create-identity` | Register a new identity and its profile dir. |
| `start-identity` | Launch Chrome for an identity. Errors if already running; `stop-identity` first to relaunch (e.g. `headless`). |
| `stop-identity` | Terminate the identity's Chrome (SIGTERM); the profile stays on disk. |
| `delete-identity` | Stop Chrome, then delete the profile dir. The only tool that discards durable state. |
| `list-sessions` | List every identity, joining on-disk registry with live running state and per-tab url/title. |

## Tabs

| Tool | Purpose |
|---|---|
| `allocate-tab` | Lease a tab exclusively to an agent; returns the scoped `cdpUrl` and `targetId`. |
| `navigate-tab` | Navigate a leased tab to a URL. |
| `set-tab-viewport` | Resize a tab's window; answers with the size actually achieved (Chrome clamps). |
| `get-tab-viewport` | Read a tab's current viewport. |
| `release-tab` | Free a tab and shrink the agent's ACL scope, live. |
| `capture-tab` | JPEG of a tab, as an MCP `image` block (REST `<img>` / CLI raw bytes elsewhere). |

## Settings & health

| Tool | Purpose |
|---|---|
| `get-settings` | Read gateway settings. |
| `set-default-viewport` | Set the default tab viewport; `0×0` clears it. |
| `health` | Health of a running identity. |

## Takeover

| Tool | Purpose |
|---|---|
| `start-takeover` | Return the human-facing viewer URL for an identity (must be running). |

## Authentication

All MCP calls require the access token as `Authorization: Bearer <token>`. This also gates `tools/list`
itself. See [Security](./security).
