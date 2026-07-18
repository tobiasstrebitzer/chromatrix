// Gateway entrypoint. Boots NestJS (management REST + silkweave MCP under /mcp) plus the raw-WS CDP mux +
// takeover routes bound to the SAME underlying http.Server — CDP frames bypass Nest's DI/guard/interceptor
// pipeline entirely (PRD §6, the "mitigating mux, not transparent proxy" crux). One process, one port.

import { startGateway } from './bootstrap.ts'

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
