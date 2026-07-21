---
title: Architecture
description: The mitigating mux, the orchestrator, and why the CDP path lives outside NestJS.
---

chromatrix is one gateway process that fronts N real Chrome instances - one per identity - and exposes
every surface on a single port.

```
   agent (raw CDP) ─wss─▶┌────────────────────────────────────────────┐
                         │           chromatrix GATEWAY               │
   LLM agent ─MCP──────▶ │  ┌──────────────┐  ┌────────────────────┐  │──CDP──▶ Chrome (identity A)
   (provisioning)        │  │ mgmt / MCP   │  │  CDP mux + mitigator│  │         userDataDir A
                         │  │ (silkweave)  │  │  · id remap         │  │──CDP──▶ Chrome (identity B)
   dashboard /           │  └──────────────┘  │  · sessionId routing│  │         userDataDir B
   takeover ───────────▶ │        └───────────│  · per-tab ACL      │  │   ...
                         │   Orchestrator     │  · leak strip       │  │
                         │   · identity registry  · profile lock     │  │
                         │   · tab pool · reaper · health            │  │
                         └────────────────────────────────────────────┘
```

## The mitigating mux, not a transparent proxy

The load-bearing design decision. Most self-hosted CDP tooling does **transparent byte-forwarding** and
delegates multiplexing to Chrome's native multi-client support. chromatrix does not: the external CDP
path is **interception-capable**. The mux:

- **Remaps per-client command ids** so concurrent clients never collide.
- **Routes events by `sessionId`** so each agent sees only its own targets.
- **Enforces a live per-tab ACL** - a scoped client may evaluate in its own tab but is denied attaching
  to another agent's target, even under the same identity.
- **Suppresses `Runtime.enable`** from reaching Chrome for unmodified raw-CDP consumers, while still
  giving them an execution context via a synthesized isolated world.

On current Chrome the in-page `Runtime.enable` getter-trap leak is already closed upstream, so the
suppression is **defense-in-depth / protocol hygiene**, not the crux. Running the genuine browser is what
matters. See [Fidelity](./fidelity).

## Why the CDP path is outside NestJS

The gateway is a NestJS app, but the raw CDP mux does **not** flow through Nest's request pipeline -
DI, guards, and interceptors add latency and would mangle the raw protocol. Instead:

- **Nest** handles the management surface: REST under `/api`, plus `/trpc` and `/mcp` via silkweave.
- **The CDP mux** is mounted at the underlying `http.Server`'s `upgrade` event, outside Nest, so CDP
  frames are message-forwarded raw.

A WebSocket handshake never reaches a Nest guard (upgrades arrive on `upgrade`, not `request`), so the
`/cdp` and `/takeover` routes authenticate themselves and can reject with a real `HTTP/1.1 401` before
accepting the socket.

## Orchestrator

The orchestrator owns durable, cross-cutting state:

- **Identity registry** - the on-disk record of every identity, joined with live running state so
  `stopped` is a resting state, not an absence.
- **Tab pool** - allocates and exclusively leases tabs; that lease *is* the mux's per-tab ACL scope.
- **Profile lock** - a single-writer lock per profile.
- **Reaper / health** - reaps orphaned Chrome process trees and reports per-identity health.

## Single origin

The gateway is the only origin. In dev it reverse-proxies to Vite; in prod it serves the built
dashboard. One port carries the dashboard, the REST/tRPC/MCP API, the takeover socket, and the muxed CDP
endpoint alike. See [Configuration](./configuration).
