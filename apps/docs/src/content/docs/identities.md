---
title: Identities & sessions
description: The four lifecycle verbs, what persists, and how sessions are listed.
---

An **identity** is a named, persistent Chrome profile with its own cookies and logins. A **session** is
a running Chrome for that identity. Identity ids are lowercase kebab slugs
(`^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars).

## Four distinct verbs

Identity lifecycle is four separate operations - only the last discards durable state:

| Verb | MCP tool | Effect |
|---|---|---|
| Create | `create-identity` | Registers the identity and its profile dir. No Chrome yet. |
| Start | `start-identity` | Launches a real headed Chrome for the profile. |
| Stop | `stop-identity` | Terminates Chrome (SIGTERM, so cookies flush). Profile stays on disk. |
| Delete | `delete-identity` | Stops Chrome, then **deletes the profile dir** - the signed-in session is gone. |

`start-identity` errors if the identity is already running - call `stop-identity` first to relaunch with
different flags (for example, `headless`).

## What persists

The profile dir is the unit of durability. It holds the signed-in session - cookies, local storage, and
anything a human established via [takeover](./takeover). Stopping and restarting an identity keeps all of
it; only **Delete** discards it. Chrome is always closed with SIGTERM so cookies flush to disk, and stale
`Singleton*` locks are cleaned before reattaching.

## Listing sessions

`list-sessions` left-joins the on-disk registry with live running state, so a created-but-stopped
identity still appears - `stopped` is a resting state, not an absence. For each running identity it
enriches the leased tabs with their live url and title.

```sh
npx @chromatrix/cli list-sessions
```

## Capacity

Rough figures measured on an Apple Silicon Mac (see [Fidelity](./fidelity)): about **375 MB per active
tab** and **~1 GB per identity instance** at base. The v1 target - 5 identities and ~10 concurrent tabs -
lands around **8.5 GB** resident: tight on 16 GB, comfortable on 32 GB and up. chromatrix optimizes for
concurrency and correctness at that scale, not raw horsepower.
