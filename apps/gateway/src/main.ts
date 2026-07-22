#!/usr/bin/env node
// Gateway entrypoint. Boots NestJS (management REST + silkweave MCP under /mcp) plus the raw-WS CDP mux +
// takeover routes bound to the SAME underlying http.Server - CDP frames bypass Nest's DI/guard/interceptor
// pipeline entirely (the "mitigating mux, not transparent proxy" crux). One process, one port.

import { configPath } from '@chromatrix/shared'
import { startGateway } from './bootstrap.ts'

// Last-resort resilience for the long-lived process: a stray socket error (a client vanishing mid-frame, a
// malformed WS frame on the dev HMR proxy path, a reset from Chrome) must never take the whole gateway down.
// Per-socket 'error' handlers are the first line (see cdp/, takeover/, @chromatrix/cdp); this net catches
// anything they miss, LOGS the full stack so nothing is hidden, and keeps serving. Deliberately NOT in
// bootstrap.ts - the e2e drivers run there and must still fail loudly on real bugs.
//
// EXCEPTION: a failed `listen` is fatal. Keeping the process alive after EADDRINUSE produces the worst
// possible outcome - the new gateway logs "started" and serves nothing, while an older process on the port
// answers every request. That reads as "my code change did nothing" and costs a debugging cycle before
// anyone thinks to check for a second gateway.
const isFatalBindError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'syscall' in err && (err as { syscall?: string }).syscall === 'listen'

process.on('uncaughtException', (err) => {
  if (isFatalBindError(err)) {
    console.error('[gateway] fatal - could not bind:', err)
    console.error('[gateway] another gateway is probably already running on this port.')
    process.exit(1)
  }
  console.error('[gateway] uncaughtException - kept alive:', err)
})
process.on('unhandledRejection', (err) => console.error('[gateway] unhandledRejection - kept alive:', err))

const handle = await startGateway()

const shutdown = async (signal: string) => {
  console.log(`\n${signal} - shutting down (SIGTERM to each Chrome so cookies flush)…`)
  await handle.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

const http = `http://${handle.host}:${handle.port}`
console.log('\n════════════════════════════════════════════════════════════════')
console.log(' chromatrix · gateway')
console.log('════════════════════════════════════════════════════════════════')
console.log(`  Dashboard  : ${http}${process.env.VITE_DEV_URL ? '   (dev: proxied to Vite HMR)' : ''}`)
console.log(`  API        : ${http}/api   ·   tRPC ${http}/trpc   ·   MCP ${http}/mcp`)
console.log(`  CDP mux    : ${handle.gateway.publicWsOrigin}/cdp/<identity>/<agentId>?token=…`)
console.log(`  Takeover   : ${http}/#/takeover/<identity>   (screencast WS: /takeover/<identity>/ws)`)

// The token is printed ONLY on the boot that minted it. Echoing a live credential to the terminal on every
// start would put it in scrollback, screen shares, and `tee`'d logs for the lifetime of the machine - but not
// printing it on first run would leave the operator with no way to learn it except reading the config file.
if (handle.tokenInit?.created) {
  console.log('\n  ── first run ──────────────────────────────────────────────')
  console.log(`  Access token: ${handle.accessToken}`)
  console.log(`  Saved to ${configPath()} (0600). This is the only time it is printed.`)
  console.log('  Use it as `Authorization: Bearer …`, or paste it into the dashboard to sign in.')
} else {
  console.log(`\n  Access token: configured (${configPath()})`)
}
if (handle.tokenInit?.exposed) {
  console.log(`  ⚠  ${configPath()} is readable beyond its owner - it holds the access token. chmod 600 it.`)
}
if (handle.host === '0.0.0.0') {
  console.log('  ⚠  Bound to 0.0.0.0 - reachable off-host. Ensure this is a trusted network (e.g. Tailscale).')
}
console.log('\n  Ctrl-C to stop.\n')
