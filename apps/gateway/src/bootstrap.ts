// Reusable gateway boot — used by main.ts (the process entrypoint) and the e2e drivers. Creates the Nest app,
// (in dev) reverse-proxies SPA/HMR routes to the Vite dev server, wires the raw-WS upgrade handler to the
// underlying http.Server, sets the public origin, and listens. Returns handles for a clean shutdown.
//
// Single origin, dev and prod (mirrors gtm/apps/server): the browser always hits the gateway's one port.
//   • dev  (VITE_DEV_URL set): SPA + HMR routes → Vite (:5181); /api,/trpc,/mcp,/cdp,/takeover stay on Nest/us.
//   • prod (VITE_DEV_URL unset): ServeStaticModule serves apps/web/dist on the same port as the API.
// So the SPA uses relative URLs in both — no CORS, no VITE_API_URL.

import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { AppModule } from './app.module.ts'
import { CdpGatewayService } from './gateway/gateway.service.ts'
import { mountGatewayUpgrades } from './cdp/cdp-upgrade.ts'

// Gateway-owned paths the dev proxy must NEVER touch: Nest's REST/tRPC/MCP transports AND the raw-WS mux
// (/cdp, /takeover). This is load-bearing for the upgrade path — see the pathFilter note below.
const isGatewayPath = (p: string) => /^\/(api|trpc|mcp|cdp|takeover)(\/|$)/.test(p)

export interface GatewayHandle {
  app: NestExpressApplication
  gateway: CdpGatewayService
  host: string
  port: number
  /** Close Nest and SIGTERM every running Chrome (cookies flush). */
  close: () => Promise<void>
}

export interface StartOptions {
  host?: string
  /** 0 → an ephemeral port (used by the e2e drivers); default 8830. */
  port?: number
  /** Overrides the public WS origin used to build scoped cdpUrls (default `ws://host:port`). */
  publicWsOrigin?: string
}

export async function startGateway(opts: StartOptions = {}): Promise<GatewayHandle> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false })
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const wantPort = opts.port ?? Number(process.env.PORT ?? 8830)

  // Dev only: reverse-proxy SPA + HMR routes to Vite so the browser hits ONE port and still gets HMR.
  // Registered BEFORE listen so it runs ahead of Nest's router (incl. ServeStatic); gateway paths fall
  // through to Nest via the pathFilter's next().
  //
  // The pathFilter is CRITICAL. With `ws: true`, http-proxy-middleware auto-subscribes its OWN
  // `server.on('upgrade')` listener (on the first request) to proxy HMR sockets. Without a filter it would
  // ALSO grab /cdp + /takeover upgrades and handle them alongside our own listener — two handlers writing
  // one socket = corrupted frames ("Invalid frame header") and crashes. The filter confines the proxy to
  // SPA + HMR; our handler exclusively owns /cdp + /takeover.
  const viteDevUrl = process.env.VITE_DEV_URL?.trim()
  if (viteDevUrl) {
    app.use(
      createProxyMiddleware({
        target: viteDevUrl,
        ws: true,
        changeOrigin: false,
        pathFilter: (pathname: string) => !isGatewayPath(pathname),
      }),
    )
  }

  const gateway = app.get(CdpGatewayService)
  const server = app.getHttpServer() as Server
  // In dev, the Vite proxy's own auto-registered 'upgrade' listener handles HMR sockets, so unmatched
  // upgrades are left untouched for it. In prod nothing else handles them, so reject.
  mountGatewayUpgrades(server, gateway, { rejectUnmatched: !viteDevUrl })

  await app.listen(wantPort, host)
  const port = (server.address() as AddressInfo).port
  gateway.publicWsOrigin =
    opts.publicWsOrigin ?? process.env.PUBLIC_WS_ORIGIN?.trim() ?? `ws://${host}:${port}`

  return {
    app,
    gateway,
    host,
    port,
    close: async () => {
      await gateway.shutdown().catch(() => {})
      await app.close().catch(() => {})
    },
  }
}
