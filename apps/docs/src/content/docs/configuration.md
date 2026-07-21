---
title: Configuration
description: The config file, the CHROMATRIX_* environment variables, and how they resolve.
---

chromatrix reads one config, from two sources, with one precedence rule:

> **environment overrides file overrides default.**

The file is the durable home for the access token and remote host; the `CHROMATRIX_*` environment
variables override any of it for a single run - which is what makes the same binary usable from a shell
script, a launchd plist, and a dev terminal without editing a file.

## The config file

Location: `~/.config/chromatrix/config.json`, written with mode `0600` (it can hold the access token).
Both halves of the system read the same file - the gateway uses `host`/`port`/`token`/`profilesDir`; the
CLI uses `gatewayUrl`/`token`.

```json
{
  "token": "…",
  "host": "127.0.0.1",
  "port": 8830,
  "gatewayUrl": "https://mac-mini.tailnet.ts.net",
  "publicOrigin": "wss://mac-mini.tailnet.ts.net",
  "profilesDir": "/Users/you/.local/share/chromatrix/profiles"
}
```

## Fields

| Field | Default | Purpose |
|---|---|---|
| `token` | minted on first boot | The single access token gating every remote surface. Absent means "not yet initialised". |
| `host` | `127.0.0.1` | Gateway bind address. Set `0.0.0.0` to accept non-loopback traffic (Tailscale, LAN). |
| `port` | `8830` | The **one** public port - dashboard, REST/tRPC/MCP, takeover socket, and muxed CDP all ride it. |
| `gatewayUrl` | unset | Where a *client* (the CLI) finds the gateway. Unset ⇒ falls back to `http://host:port`. |
| `publicOrigin` | bind address | Origin advertised in generated URLs (scoped `cdpUrl`s, takeover viewer) when behind a proxy or Tailscale name. |
| `profilesDir` | see below | Absolute path to the identity profile root. |

There is exactly one port. Chrome's own debugging ports are ephemeral (`--remote-debugging-port=0`) and
bound to loopback - never published.

## Environment variables

Each `CHROMATRIX_*` variable overrides the matching field. Note that **bare `PORT`/`HOST` are not read** -
the prefix is required.

| Variable | Field |
|---|---|
| `CHROMATRIX_TOKEN` | `token` |
| `CHROMATRIX_HOST` | `host` |
| `CHROMATRIX_PORT` | `port` |
| `CHROMATRIX_GATEWAY_URL` | `gatewayUrl` |
| `CHROMATRIX_PUBLIC_ORIGIN` | `publicOrigin` |
| `CHROMATRIX_PROFILES` | `profilesDir` |

## Where profiles live

Profiles hold live, signed-in sessions, so their location is deliberate:

- **From a dev checkout** - `<repo>/.profiles/<id>/` (gitignored).
- **From an npm install** - `~/.local/share/chromatrix/profiles/<id>/`.

`profilesDir` (or `CHROMATRIX_PROFILES`) overrides both. It must be an **absolute** path - a relative
path silently resolves against the process cwd, which differs between a dev shell and launchd.
