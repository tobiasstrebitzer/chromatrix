# @chromatrix/gateway

The [chromatrix](../../README.md) control plane: NestJS + `@silkweave/nestjs`, serving a raw-WS CDP mux
mounted at the underlying `http.Server` (outside Nest's request pipeline) alongside MCP/tRPC provisioning
and the takeover route. One process, one port.

## Run it

From an npm install (the dashboard ships inside the package):

```sh
npx @chromatrix/gateway
```

From a dev checkout:

```sh
pnpm install
pnpm --filter @chromatrix/gateway run start
```

Boots on `:8830` (`CHROMATRIX_PORT` to change it), prints the access token once on the boot that mints it,
and serves:

- `/api` - REST management routes
- `/trpc` - the dashboard's typed client
- `/mcp` - the agent-facing MCP surface (15 tools; provisioning-only, see the root README)
- `/cdp/<identity>/<agentId>` - the raw-WS CDP mux, per-agent scoped and ACL'd
- `/takeover/<identity>` - the human-takeover screencast + input WS
- `/` - the dashboard SPA (dev: proxied to Vite HMR; prod: served static - `apps/web/dist` in a checkout,
  the bundled `web/` dir in the published package)

One access token gates every surface - `Authorization: Bearer` for programmatic clients, an HttpOnly cookie
for the dashboard, `?token=` on the raw-WS upgrades. See [`CLAUDE.md`](../../CLAUDE.md) for the full auth
model (including the derived, one-way per-agent CDP token).

## Testing

```sh
pnpm --filter @chromatrix/gateway run accept   # ACL + auth-perimeter acceptance test (HEADLESS=1 for no window)
pnpm --filter @chromatrix/gateway run e2e      # concurrent multi-identity/agent/tab fleet e2e
```

## Packaging

`prepack` builds the server bundle (tsdown + SWC - SWC because Nest's DI and the ValidationPipe need
`emitDecoratorMetadata`, which oxc doesn't produce) and copies the built dashboard into `web/`, which ships
in the package. At runtime the gateway detects which shape it's in: a dev checkout serves `apps/web/dist`,
regenerates the tRPC types on boot, and defaults profiles to `<repo>/.profiles`; an npm install serves the
bundled `web/`, skips typegen, and defaults profiles to `~/.local/share/chromatrix/profiles`.

Part of the [chromatrix](../../README.md) monorepo - see the root README for the full architecture.
