---
title: CLI
description: A remote client for the gateway whose commands are derived live from the MCP surface.
---

The chromatrix CLI is a thin **remote** client for the gateway. It has, by design, **no per-command
code**: it connects to the gateway's MCP endpoint, calls `tools/list`, and synthesizes one command per
tool from its JSON Schema. The CLI's surface *is* the gateway's MCP surface - adding a tool to the gateway
adds a command to the CLI with zero code change, so the two can never drift apart.

## Install

Run it with `npx`, or install it:

```sh
npx @chromatrix/cli list-sessions
# or
npm install -g @chromatrix/cli
```

## Pointing it at a gateway

The CLI reads the same [config](./configuration) the gateway does:

- **Local gateway** - nothing to set; it uses `http://host:port`.
- **Remote gateway** - set `gatewayUrl` (or `CHROMATRIX_GATEWAY_URL`) and the token:

```sh
CHROMATRIX_GATEWAY_URL=https://mac-mini.tailnet.ts.net \
CHROMATRIX_TOKEN=… \
npx @chromatrix/cli list-sessions
```

If no token is configured, the CLI tells you where to set it - the gateway prints its token once, on the
first run that mints it.

## Common commands

Because commands are generated, this list mirrors the [MCP tools](./mcp-tools) exactly:

```sh
chromatrix create-identity --id work-twitter
chromatrix start-identity  --id work-twitter
chromatrix list-sessions
chromatrix allocate-tab    --identity work-twitter --agent-id scout --url https://example.com
chromatrix navigate-tab    --identity work-twitter --target-id ABC123 --url https://example.org
chromatrix capture-tab     --identity work-twitter --target-id ABC123 > shot.jpg
chromatrix release-tab     --identity work-twitter --target-id ABC123
chromatrix stop-identity   --id work-twitter
```

## Binary output

`capture-tab` is declared as a binary resource by the gateway, and the CLI respects the destination:
piped stdout receives **raw bytes** (`… > shot.jpg`), while an interactive terminal gets a written file
instead. Binary is never dumped onto a TTY.
