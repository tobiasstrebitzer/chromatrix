# @chromatrix/gateway

The [chromatrix](../../README.md) control plane: NestJS + `@silkweave/nestjs`, serving a raw-WS CDP mux
mounted at the underlying `http.Server` (outside Nest's request pipeline) alongside MCP/tRPC provisioning
and the takeover route. One process, one port. Not published to npm yet — see
[Publishing](#publishing) below.

## Run it

```sh
pnpm install
pnpm --filter @chromatrix/gateway run start
```

Boots on `:8830` (`CHROMATRIX_PORT` to change it), prints the access token once on the boot that mints it,
and serves:

- `/api` — REST management routes
- `/trpc` — the dashboard's typed client
- `/mcp` — the agent-facing MCP surface (15 tools; provisioning-only, see the root README)
- `/cdp/<identity>/<agentId>` — the raw-WS CDP mux, per-agent scoped and ACL'd
- `/takeover/<identity>` — the human-takeover screencast + input WS
- `/` — the dashboard SPA (dev: proxied to Vite HMR; prod: `apps/web/dist`, served static)

One access token gates every surface — `Authorization: Bearer` for programmatic clients, an HttpOnly cookie
for the dashboard, `?token=` on the raw-WS upgrades. See [`CLAUDE.md`](../../CLAUDE.md) for the full auth
model (including the derived, one-way per-agent CDP token).

## Testing

```sh
pnpm --filter @chromatrix/gateway run accept   # ACL + auth-perimeter acceptance test (HEADLESS=1 for no window)
pnpm --filter @chromatrix/gateway run e2e      # concurrent multi-identity/agent/tab fleet e2e
```

## Publishing

This app is **not yet publishable** to npm: it resolves the workspace root and `apps/web/dist` by walking up
from its own file to find `pnpm-workspace.yaml`, and writes tRPC types into `apps/web/src/generated/` on
every boot — both assume a monorepo checkout, not an installed package. Packaging it as a standalone
`npx @chromatrix/gateway` (bundling the dashboard, decoupling the repo-root-relative paths) is tracked in
[`docs/NEXT-SESSION.md`](../../docs/NEXT-SESSION.md). Until then, run it from a clone as above.

Part of the [chromatrix](../../README.md) monorepo — see the root README for the full architecture.
