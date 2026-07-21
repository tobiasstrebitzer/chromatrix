#!/usr/bin/env node
// chromatrix CLI - a thin *remote* client for the gateway.
//
// There is deliberately no per-command code here. `cliProxy` connects to the gateway's MCP endpoint, calls
// `tools/list`, and synthesizes one commander subcommand per tool from its JSON Schema. So the CLI's surface
// IS the gateway's @Mcp surface, always in sync: adding a tool to the gateway adds a command here with no
// change to this file.
//
//   chromatrix create-identity work-twitter
//   chromatrix allocate-tab --identity work-twitter --agent-id scout --url https://example.com
//   chromatrix capture-tab --identity work-twitter --target-id ABC123 > shot.jpg
//
// The last one works because the gateway declares that route as a binary resource: piped stdout gets raw
// bytes, an interactive terminal gets a written file instead. Binary is never dumped onto a TTY.

import { silkweave } from '@silkweave/core'
import { cliProxy } from '@silkweave/mcp/cli-proxy'
import { ConfigError, configPath, loadConfig } from '@chromatrix/shared'

let config
try {
  config = loadConfig()
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : String(err))
  process.exit(1)
}

// `gatewayUrl` is the remote case (a Mac mini over Tailscale); host/port is the local one. Both come from the
// same config file, so pointing the CLI at a different gateway is one field or one CHROMATRIX_GATEWAY_URL.
const base = config.gatewayUrl ?? `http://${config.host}:${config.port}`

if (!config.token) {
  console.error(
    `No access token configured.\n` +
      `  Set one in ${configPath()} ("token": "…"), or export CHROMATRIX_TOKEN.\n` +
      `  The gateway prints its token once, on the first run that mints it.`,
  )
  process.exit(1)
}

await silkweave({
  name: 'chromatrix',
  description: `chromatrix gateway CLI - ${base}`,
  version: '0.1.1',
})
  .adapter(
    cliProxy({
      url: new URL('/mcp', base),
      // Same single credential every other surface uses. A thunk so the token is read at invocation rather
      // than baked in at module load - it costs nothing and keeps rotation a restart-free change.
      headers: () => ({ authorization: `Bearer ${config.token}` }),
    }),
  )
  .start()
