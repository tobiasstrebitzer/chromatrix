# @chromatrix/cli

The [chromatrix](../../README.md) CLI - a thin **remote** client over the gateway's MCP surface
(`@silkweave/mcp` `cliProxy`). There is deliberately no per-command code: the CLI calls the gateway's
`tools/list` and synthesizes one subcommand per tool from its JSON Schema, so the CLI's surface *is* the
gateway's `@Mcp` surface, always in sync - adding a tool to the gateway adds a command here with zero
changes to this package.

```sh
npx @chromatrix/cli --help
```

## Configure

The CLI reads the same config as the gateway: `~/.config/chromatrix/config.json`, overridden by
`CHROMATRIX_*` env. Point it at a remote gateway (e.g. a Mac mini over Tailscale):

```sh
export CHROMATRIX_GATEWAY_URL=https://mac-mini.tailnet.ts.net
export CHROMATRIX_TOKEN=…   # the gateway prints this once, on the boot that mints it
```

Or run it against a local gateway with no env at all - it defaults to `http://127.0.0.1:8830`.

## Usage

```sh
chromatrix create-identity --id work-twitter
chromatrix start-identity --id work-twitter
chromatrix allocate-tab --identity work-twitter --agent-id scout --url https://example.com
chromatrix navigate-tab --identity work-twitter --target-id ABC123 --url https://example.com/page
chromatrix capture-tab --identity work-twitter --target-id ABC123 > shot.jpg
chromatrix list-sessions
chromatrix stop-identity --id work-twitter
```

`capture-tab`'s output is a silkweave binary resource: piped to a file it writes a real JPEG (as above);
the same route also serves the dashboard's `<img src>` and an MCP `image` block for agents - one endpoint,
three shapes.

Run `chromatrix --help` for the full, always-current command list (it's whatever the connected gateway
exposes).

## Development

```sh
pnpm --filter @chromatrix/cli run start -- --help   # run from source, no build step
pnpm --filter @chromatrix/cli run typecheck
pnpm --filter @chromatrix/cli run build             # tsdown → build/index.mjs (only on prepack/CI)
```

Part of the [chromatrix](../../README.md) monorepo - see the root README for the full architecture.
