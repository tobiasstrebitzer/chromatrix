---
title: Tabs & concurrency
description: Exclusive tab leasing, the per-tab ACL, real-window viewports, and screenshots.
---

Many agents can share one identity's Chrome - the concurrency model that makes that safe is **shared
context, exclusive tab leasing**.

## Why shared context

Every tab under an identity shares one browser context, so they share the identity's login. This was the
sound model found in testing: multiple concurrent agents, each in its own tab, all complete and all see
the shared login cookie. An ephemeral `Target.createBrowserContext` per job *isolates* storage but does
**not** inherit the persistent login - the wrong tool for per-job isolation under a signed-in identity.

## Why leasing is exclusive

Forcing two agents onto one tab breaks the in-flight operation (`Inspected target navigated or closed`).
So **tab affinity is mandatory**: a tab is leased to exactly one agent at a time. That lease is not just
bookkeeping - it *is* the mux's live per-tab ACL scope.

```sh
npx @chromatrix/cli allocate-tab --identity work-twitter --agent-id scout --url https://example.com
```

This returns a scoped CDP URL (`/cdp/<identity>/<agentId>?token=…`). The agent driving that URL:

- **can** attach to and evaluate in its own leased tab;
- **cannot** see or attach to another agent's tab - even a peer under the *same* identity;
- loses that scope the moment the tab is released (`release-tab`), live.

Shared storage and cookies are last-writer-wins across agents, so agents should namespace their own keys;
the orchestrator owns genuinely shared state.

## Viewports are real windows

A tab's viewport is a **real window size, not an emulation override**. Each tab opens as its own window
and is sized with `Browser.setWindowBounds` plus a measured per-window chrome delta - nothing is executed
inside the page. `Emulation.setDeviceMetricsOverride` was evaluated and rejected: it produces a viewport
larger than its own window, a state no real display can produce, which is exactly the kind of tell
chromatrix refuses to introduce.

The honest cost: Chrome won't make a window smaller than **500×375 outer (500×288 content)**, so
phone-width viewports are out of reach. That is a real constraint accepted rather than faked. `set-tab-viewport`
answers with the size actually achieved, not the size requested - Chrome silently clamps, and echoing the
request back would make the UI lie.

## Screenshots

`capture-tab` returns a JPEG of one tab, served three ways from one route:

- **REST** - raw `image/jpeg`, so an `<img src>` is the client (the dashboard polls this).
- **MCP** - a real `image` content block an agent can actually see.
- **CLI** - raw bytes on stdout: `chromatrix capture-tab … > shot.jpg`.

A one-off capture works on a backgrounded tab (it asks for a fresh raster), which is what makes the
dashboard's grid of passive thumbnails viable without stealing focus.
