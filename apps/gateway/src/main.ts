// Gateway entrypoint. Boots NestJS (management REST + silkweave MCP under /mcp) plus the raw-WS CDP mux +
// takeover routes bound to the SAME underlying http.Server — CDP frames bypass Nest's DI/guard/interceptor
// pipeline entirely (PRD §6, the "mitigating mux, not transparent proxy" crux). One process, one port.

import { startGateway } from './bootstrap.ts'

// Last-resort resilience for the long-lived process: a stray socket error (a client vanishing mid-frame, a
// malformed WS frame on the dev HMR proxy path, a reset from Chrome) must never take the whole gateway down.
// Per-socket 'error' handlers are the first line (see cdp/, takeover/, @chromatrix/cdp); this net catches
// anything they miss, LOGS the full stack so nothing is hidden, and keeps serving. Deliberately NOT in
// bootstrap.ts — the e2e drivers run there and must still fail loudly on real bugs.
process.on('uncaughtException', (err) => console.error('[gateway] uncaughtException — kept alive:', err))
process.on('unhandledRejection', (err) => console.error('[gateway] unhandledRejection — kept alive:', err))

const handle = await startGateway()

const shutdown = async (signal: string) => {
  console.log(`\n${signal} — shutting down (SIGTERM to each Chrome so cookies flush)…`)
  await handle.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

const http = `http://${handle.host}:${handle.port}`
console.log('\n════════════════════════════════════════════════════════════════')
console.log(' chromatrix · gateway')
console.log('════════════════════════════════════════════════════════════════')
console.log(`  Dashboard  : ${http}${process.env.VITE_DEV_URL ? '   (dev: proxied to Vite HMR)' : '   (serving apps/web/dist)'}`)
console.log(`  API        : ${http}/api   ·   tRPC ${http}/trpc   ·   MCP ${http}/mcp`)
console.log(`  CDP mux    : ${handle.gateway.publicWsOrigin}/cdp/<identity>?token=…`)
console.log(`  Takeover   : ${http}/#/takeover/<identity>   (screencast WS: /takeover/<identity>/ws)`)
console.log('  Ctrl-C to stop.\n')
