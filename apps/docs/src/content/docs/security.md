---
title: Security & auth
description: One access token, per-surface guarding, derived per-agent credentials, and edge hardening.
---

chromatrix's auth model is deliberately small: **one access token gates everything**, and agents never
hold it.

## One token, many carriers

There is a single access token for the whole gateway. What varies is only how a client *carries* it - the
transport dictates that:

| Client | Carrier |
|---|---|
| Programmatic (CLI, MCP, REST) | `Authorization: Bearer <token>` |
| Dashboard (browser) | HttpOnly cookie |
| Raw-WS upgrades (`/cdp`, `/takeover`) | `?token=` in the URL (a CDP client can't set a handshake header) |

All paths converge on **one constant-time comparison**. The token is minted on first boot and stored in
`~/.config/chromatrix/config.json` (mode `0600`).

## Per-surface guarding

Guarding is applied where each surface actually lives:

- **`/api/*`** - a global NestJS guard.
- **`/trpc` + `/mcp`** - silkweave auth at the transport, which also closes `tools/list`.
- **`/cdp` + `/takeover`** - a self-check on the WebSocket handshake, because an upgrade never reaches a
  Nest guard. These can reject with a real `HTTP/1.1 401` before the socket is accepted.

Because the dashboard can only present an HttpOnly cookie but silkweave's auth reads `Authorization:
Bearer` and nothing else, a small bridge (`cookieToBearer`) converts one to the other - same credential,
different carrier.

## Agents never hold the operator credential

An agent's scoped `/cdp/<identity>/<agentId>` URL is authenticated by a **derived** token:

```
derivedToken = HMAC(accessToken, identity ‖ agentId)
```

This is one-way and recomputed on demand - there is no token table and no per-agent revocation. An agent
holds a credential that proves "I am agentId on this identity" and nothing more; it cannot be reversed
into the operator token that could delete every identity. This is why the client has to *name* its agent
in the URL: the HMAC proves the claim.

## Edge hardening

- **DTO validation at the edge.** A global validation pipe rejects a malformed request body with a `400`
  before it reaches any handler.
- **Login throttling.** Repeated `/api/auth/login` failures are throttled with a sliding window (`429`
  with `Retry-After`, keyed by socket address). The token is 256-bit, so brute force isn't the threat -
  this bounds noise. A *successful* login clears the failure history; and Bearer auth is never throttled,
  so the operator can't lock themselves out.

## Exposure

Bind to loopback unless you mean not to. Binding `0.0.0.0` is opt-in precisely because it requires the
token to be safe - pair it with Tailscale rather than the public internet (see [Deployment](./deployment)).
