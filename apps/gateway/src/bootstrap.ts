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
import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import express from 'express'
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { loadConfig } from '@chromatrix/shared'
import { AppModule } from './app.module.ts'
import { CdpGatewayService } from './gateway/gateway.service.ts'
import { cookieToBearer, getAccessToken, initAccessToken, setAccessToken, type TokenInit } from './auth/auth.ts'
import { mountGatewayUpgrades } from './cdp/cdp-upgrade.ts'

// Gateway-owned paths the dev proxy must NEVER touch: Nest's REST/tRPC/MCP transports AND the raw-WS mux
// (/cdp, /takeover). This is load-bearing for the upgrade path — see the pathFilter note below.
const isGatewayPath = (p: string) => /^\/(api|trpc|mcp|cdp|takeover)(\/|$)/.test(p)

export interface GatewayHandle {
  app: NestExpressApplication
  gateway: CdpGatewayService
  host: string
  port: number
  /** The access token every surface authenticates against — main.ts prints it on first run. */
  accessToken: string
  /** Set when this boot minted the token, or when the config file is readable beyond its owner. */
  tokenInit?: TokenInit
  /** Close Nest and SIGTERM every running Chrome (cookies flush). */
  close: () => Promise<void>
}

export interface StartOptions {
  host?: string
  /** 0 → an ephemeral port (used by the e2e drivers); default from config (8830). */
  port?: number
  /** Overrides the public WS origin used to build scoped cdpUrls (default `ws://host:port`). */
  publicWsOrigin?: string
  /**
   * Boot with a specific access token instead of resolving (and possibly minting) the user's real one. The
   * e2e drivers use this so a test run never reads, writes, or depends on ~/.config/chromatrix/config.json.
   */
  accessToken?: string
}

export async function startGateway(opts: StartOptions = {}): Promise<GatewayHandle> {
  // BEFORE the Nest app: the global guard asserts the token exists at module init, and the CdpGatewayService
  // derives per-agent tokens from it. Booting without a token must fail here, not on the first request.
  const tokenInit = opts.accessToken ? (setAccessToken(opts.accessToken), undefined) : initAccessToken()

  const config = loadConfig()

  // We construct the Express instance ourselves so `cookieToBearer` is registered BEFORE Nest initialises.
  // This ordering is load-bearing and was a real bug: the silkweave adapters mount their /trpc and /mcp
  // handlers during `NestFactory.create`, so an `app.use()` afterwards runs too late and the dashboard —
  // which can only present an HttpOnly cookie — 401s on every tRPC call while /api works fine.
  const instance = express()
  instance.use(cookieToBearer)

  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(instance), {
    bufferLogs: false,
  })
  const host = opts.host ?? config.host
  const wantPort = opts.port ?? config.port

  // Without a global pipe the class-validator rules on the DTOs are declarations only — a malformed body
  // reaches the handler as-is and fails somewhere deeper with a 500. `whitelist` strips fields the DTO never
  // declared, so extra body keys can't ride into the service layer.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))

  // Behind a TLS-terminating proxy (Tailscale Serve, nginx), `req.protocol` reads X-Forwarded-Proto only with
  // this set — which is what decides whether the login cookie gets the `Secure` flag.
  app.set('trust proxy', true)

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
  gateway.publicWsOrigin = opts.publicWsOrigin ?? config.publicOrigin ?? `ws://${host}:${port}`

  return {
    app,
    gateway,
    host,
    port,
    accessToken: getAccessToken(),
    tokenInit,
    close: async () => {
      await gateway.shutdown().catch(() => {})
      await app.close().catch(() => {})
    },
  }
}
