---
title: Packages
description: The six published packages and how they fit together.
---

chromatrix is a pnpm workspace of four libraries and three apps. All six publishable packages are on npm
under the `chromatrix` org, MIT-licensed.

## Libraries

| Package | Role |
|---|---|
| `@chromatrix/cdp` | `CdpClient` + `CdpMux`: id-remap, `sessionId` routing, per-tab ACL, and the interceptor seam. |
| `@chromatrix/fidelity` | `launchChrome` + fingerprint-hygiene launch flags + the verification probes behind `pnpm fidelity:check`. |
| `@chromatrix/core` | The domain: identity registry, tab pool, profile lock, reaper, supervisor, orchestrator. |
| `@chromatrix/shared` | Config schema (zod) + access-token primitives. The CLI's only workspace dependency. |

## Apps

| Package | Role |
|---|---|
| `@chromatrix/gateway` | NestJS: raw-WS CDP mux (outside Nest) + per-tab ACL + MCP/tRPC provisioning + takeover. Bundles the dashboard, so `npx @chromatrix/gateway` is standalone. |
| `@chromatrix/web` | React 19 + Vite + Tailwind v4 dashboard (sessions + live takeover). Served by the gateway. |
| `@chromatrix/cli` | Remote CLI over the gateway's MCP surface; commands derived from `tools/list`, no per-command code. |

## How they depend

```text
shared ──▶ cli
  │
cdp ──▶ core ──┐
fidelity ──────┼──▶ gateway ──▶ (serves) web
               │
        (all libs)
```

`shared` is intentionally the CLI's only workspace dep - the CLI is a thin MCP client and needs nothing
else. The gateway is the one place that pulls the mux, fidelity, and the orchestrator together.

## Toolchain

pnpm 11 workspace, Node 24, ESM everywhere, Turbo for the build graph. TypeScript typechecks via `tsgo`
(no `tsc`); oxlint only (no Prettier/ESLint). Libraries and the CLI/gateway build with `tsdown` on
prepack/CI only - in dev, apps resolve workspace packages straight to TS source via the
`@chromatrix/source` export condition, with no build step.

## Install

```sh
npm install @chromatrix/gateway   # the server (bundles the dashboard)
npm install @chromatrix/cli       # the remote CLI
```

The libraries are published for anyone building on the primitives directly, but most users only need the
gateway and the CLI.
