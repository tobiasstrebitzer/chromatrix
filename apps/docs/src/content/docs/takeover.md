---
title: Human takeover
description: Live view and hands-on control - the supported path for logins and verification gates.
---

Takeover lets a human see and drive any tab directly. It is the supported path for two things that must
be done by a person: **the one-time login that bootstraps an identity**, and **the occasional interactive
verification gate** an authorized target throws up.

## How it works

Takeover is built on two CDP primitives:

- **`Page.startScreencast`** (JPEG, quality ~75, ack-throttled) streams frames from the tab, fanned out
  to every connected viewer.
- **`Input.dispatch*`** forwards mouse and keyboard events into the tab.

Injected input is **`isTrusted`** - because it goes through the browser's real input pipeline, the same
one a physical mouse and keyboard use. A click fires the page's handler with `isTrusted === true`; typing
lands in focused inputs.

## Starting a takeover

From the dashboard, open an identity's **Takeover** view. Or provision it over MCP/CLI:

```sh
npx @chromatrix/cli start-takeover --identity work-twitter
```

This returns the viewer URL (the dashboard's takeover route). The identity must be running first. The
takeover view offers a browser-style tab strip (favicon, title, agent badge, inline release), Fit vs 1:1
zoom, and a keyboard-focus affordance.

## Bootstrapping a login

The intended flow for an identity that needs a login:

1. `create-identity` and `start-identity`.
2. Open **Takeover** and sign in **by hand**, as a human.
3. The session persists into the identity's profile dir and survives relaunches (SIGTERM flushes cookies;
   stale singleton locks are cleaned on reattach).

After that, the identity's agents share the login (see [Tabs & concurrency](./tabs)) until it expires.

## Verification gates stay human

chromatrix does **not** auto-solve CAPTCHAs, Turnstile, or Cloudflare managed challenges - auto-solving a
human-verification gate is exactly the "fake a human" behaviour it excludes. The value chromatrix adds is
that a human solves the gate **once** per identity via takeover, and the resulting session (for example a
`cf_clearance` cookie) then persists and is shared across the identity's agents until it expires. See
[Fidelity](./fidelity) for the compatibility matrix behind this.

## Notes

- The takeover socket accepts `?token=` for non-browser viewers, which puts a credential in a query
  string. Nothing logs it - prefer the cookie path where you can.
- WebRTC / audio and OS-level dialog interaction are out of scope; takeover is CDP screencast + input,
  which is sufficient for login-grade interaction.
