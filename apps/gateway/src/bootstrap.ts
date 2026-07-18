// Reusable gateway boot — used by main.ts (the process entrypoint) and the e2e drivers. Creates the Nest app,
// (in dev) reverse-proxies non-API routes to the Vite dev server for HMR, wires the raw-WS upgrade handler to
// the underlying http.Server, sets the public origin, and listens. Returns handles for a clean shutdown.
//
// Single origin, dev and prod (mirrors gtm/apps/server): the browser always hits the gateway's one port.
//   • dev  (VITE_DEV_URL set): non-reserved routes → Vite (:5181) for HMR; /api,/trpc,/mcp fall through to Nest.
//   • prod (VITE_DEV_URL unset): ServeStaticModule serves apps/web/dist on the same port as the API.
// So the SPA uses relative URLs in both — no CORS, no VITE_API_URL.

import 'reflect-metadata'
import type { AddressInfo, Socket } from 'node:net'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createProxyMiddleware, type RequestHandler } from 'http-proxy-middleware'
import { AppModule } from './app.module.ts'
import { CdpGatewayService } from './gateway/gateway.service.ts'
import { mountGatewayUpgrades } from './cdp/cdp-upgrade.ts'

// Nest-owned HTTP prefixes the SPA dev-proxy must NOT swallow (REST under /api + the silkweave /trpc + /mcp
// transports). Raw-WS routes (/cdp, /takeover/…/ws) are upgrades, never HTTP GETs, so they aren't matched here.
const RESERVED = /^\/(api|trpc|mcp)(\/|$)/

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

  // Dev only: reverse-proxy every non-reserved route to Vite so the browser hits ONE port and still gets HMR.
  // Registered as plain express middleware BEFORE listen so it runs ahead of Nest's router (incl. ServeStatic);
  // reserved prefixes fall through to Nest.
  const viteDevUrl = process.env.VITE_DEV_URL?.trim()
  let devProxy: RequestHandler | undefined
  if (viteDevUrl) {
    devProxy = createProxyMiddleware({ target: viteDevUrl, ws: true, changeOrigin: false })
    app.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      const path = (req.url ?? '/').split('?', 1)[0]
      return RESERVED.test(path) ? next() : devProxy!(req, res, next)
    })
  }

  const gateway = app.get(CdpGatewayService)
  const server = app.getHttpServer() as Server
  // Our raw-WS handler owns /cdp + /takeover upgrades; anything else (e.g. Vite HMR) falls back to the dev
  // proxy's upgrade in dev, or is rejected in prod. (http-proxy-middleware types the socket as net.Socket;
  // the http `upgrade` event hands us exactly that, so the cast is sound.)
  const proxyUpgrade = devProxy?.upgrade
  const fallbackUpgrade = proxyUpgrade
    ? (req: IncomingMessage, socket: Duplex, head: Buffer) => proxyUpgrade(req, socket as Socket, head)
    : undefined
  mountGatewayUpgrades(server, gateway, fallbackUpgrade)

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
