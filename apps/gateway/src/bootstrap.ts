// Reusable gateway boot — used by both main.ts (the process entrypoint) and acceptance.ts (the end-to-end
// driver). Creates the Nest app, wires the raw-WS upgrade handler to the underlying http.Server, sets the
// public origin, and listens. Returns handles for a clean shutdown.

import 'reflect-metadata'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.ts'
import { CdpGatewayService } from './gateway.service.ts'
import { mountGatewayUpgrades } from './cdp-upgrade.ts'

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
  /** 0 → an ephemeral port (used by the acceptance test); default 8830. */
  port?: number
  /** Overrides the public WS origin used to build scoped cdpUrls (default `ws://host:port`). */
  publicWsOrigin?: string
}

export async function startGateway(opts: StartOptions = {}): Promise<GatewayHandle> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false })
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const wantPort = opts.port ?? Number(process.env.PORT ?? 8830)

  const gateway = app.get(CdpGatewayService)
  const server = app.getHttpServer() as Server
  mountGatewayUpgrades(server, gateway)

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
