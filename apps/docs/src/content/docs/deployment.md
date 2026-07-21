---
title: Deployment
description: Running chromatrix for real on a Mac mini behind Tailscale.
---

Dev happens on a MacBook; production is a dedicated Mac mini kept running and reached over Tailscale. The
gateway itself is host-agnostic - nothing is hardcoded to a machine - but a few things matter for a
long-lived headed-Chrome host.

## A GUI session and a display

chromatrix runs **headed** Chrome, so it needs:

- an **Aqua GUI session** - auto-login the Mac so a desktop session exists for Chrome to draw into;
- a **display attached** - a real monitor or a dummy/virtual HDMI dongle, so the GPU engages and WebGL
  reports the authentic Metal renderer (see [Fidelity](./fidelity)).

## Keep it running

Use a LaunchAgent (not a LaunchDaemon - it must run inside the logged-in GUI session) with `KeepAlive`,
so the gateway comes back after a crash or reboot. Run the gateway with the process manager of your
choice; `node build/main.mjs` from the packaged app behaves as an install-mode boot.

## Bind and advertise for Tailscale

By default the gateway binds loopback. To reach it across your tailnet:

```sh
CHROMATRIX_HOST=0.0.0.0 \
CHROMATRIX_PUBLIC_ORIGIN=wss://mac-mini.tailnet.ts.net \
node build/main.mjs
```

- `CHROMATRIX_HOST=0.0.0.0` accepts non-loopback traffic. This is only safe because every surface is
  gated by the access token - see [Security](./security).
- `CHROMATRIX_PUBLIC_ORIGIN` sets the origin advertised in generated URLs (the scoped `cdpUrl`s and the
  takeover viewer link), so they are reachable at the tailnet name rather than at the bind address.

Keep the gateway itself off the public internet - expose it only over the tailnet.

## Profiles

Set `CHROMATRIX_PROFILES` to an absolute path for where identity profiles live in prod. These dirs hold
live signed-in sessions, so put them somewhere backed up and durable. An absolute path is required - a
relative one resolves against the process cwd, which differs under a launch agent.

## A note on stale processes

A stale gateway is the most expensive failure mode: a new process logs "started" while an old one still
answers on the port, which reads exactly like "my change did nothing". The gateway exits non-zero on a
`listen` failure for this reason. If something inexplicably ignores a change, check for a second listener
first (`lsof -nP -iTCP:8830 -sTCP:LISTEN`).
