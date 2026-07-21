# @chromatrix/cdp

CDP client + flat-session multiplexer: one upstream connection to Chrome, N downstream clients, each scoped
to its own targets. The mitigating-mux mechanism at the core of [chromatrix](../../README.md) — mechanism
only, no fidelity policy (that's [`@chromatrix/fidelity`](../fidelity)).

```sh
pnpm add @chromatrix/cdp
```

## What it does

- **`CdpClient`** — a minimal CDP client: `send()`, `on()`, session-aware, no framework assumptions.
- **`CdpMux`** — the multiplexer: takes one upstream `browserWsUrl`, accepts N downstream WebSocket clients,
  remaps command ids per client so responses route correctly, fans out events by `sessionId`, and evaluates
  every downstream message through a pluggable `Interceptor` before it reaches Chrome.
- **`ClientScope`** — the live per-tab ACL: which target ids a given client may see or attach to.
  `unrestrictedScope` is the no-op default; [`apps/gateway`](../../apps/gateway) supplies a real one keyed to
  each agent's lease.
- **`Interceptor`** seam — a hook to inspect/rewrite/drop a downstream message before it's forwarded upstream.
  `transparentInterceptor` is a no-op passthrough; `@chromatrix/fidelity`'s
  `runtimeEnableSuppressInterceptor` plugs in here to suppress `Runtime.enable` as defense-in-depth against
  the classic in-page getter-leak (see [`docs/FINDINGS.md`](../../docs/FINDINGS.md) — closed upstream on
  Chrome 150, kept as hygiene).

## Development

```sh
pnpm --filter @chromatrix/cdp run typecheck
pnpm --filter @chromatrix/cdp run test
pnpm --filter @chromatrix/cdp run build   # tsdown → build/ (only on prepack/CI)
```

Part of the [chromatrix](../../README.md) monorepo — see the root README for the full architecture.
