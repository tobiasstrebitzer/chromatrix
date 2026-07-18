// Raw-WS upgrade wiring — the architectural crux (PRD §6). NestJS owns the HTTP + MCP surface, but CDP frames
// must NOT traverse Nest's DI/guard/interceptor pipeline: they are high-volume binary-ish JSON routed by the
// mux, not Nest routes. So we bind our own handler to the underlying http.Server's `upgrade` event (ahead of
// anything Nest does with upgrades) and hand matched sockets straight to the per-identity CdpMux / TakeoverHub.
//
//   /cdp/<identity>?token=…       → agent raw-CDP, attached under the live per-tab ACL scope
//   /takeover/<identity>/ws       → human live-view + input (screencast fan-out)
//
// Anything else is destroyed (Nest has no WS routes of its own here).

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Logger } from '@nestjs/common'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CdpGatewayService } from './gateway.service.ts'
import { TakeoverHub } from './takeover.ts'

const CDP_RE = /^\/cdp\/([a-z0-9][a-z0-9_-]{0,63})$/
const TAKEOVER_RE = /^\/takeover\/([a-z0-9][a-z0-9_-]{0,63})\/ws$/

export function mountGatewayUpgrades(server: Server, service: CdpGatewayService): void {
  const log = new Logger('CdpUpgrade')
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
  const takeoverHubs = new Map<string, TakeoverHub>()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    const cdp = CDP_RE.exec(path)
    if (cdp) {
      const identity = cdp[1]
      const token = url.searchParams.get('token') ?? undefined
      let resolved
      try {
        resolved = service.resolveCdpUpgrade(identity, token)
      } catch (e) {
        log.warn(`cdp upgrade rejected for "${identity}": ${(e as Error).message}`)
        return reject(socket, 403)
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        resolved.mux.attachClient(ws, resolved.scope)
        log.log(`cdp client attached to "${identity}" (scope: ${resolved.scope.allowedTargets().length} tab(s))`)
      })
      return
    }

    const takeover = TAKEOVER_RE.exec(path)
    if (takeover) {
      const identity = takeover[1]
      if (!service.isRunning(identity)) return reject(socket, 404)
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        let hub = takeoverHubs.get(identity)
        if (!hub) {
          hub = new TakeoverHub(service.controlClient(identity))
          takeoverHubs.set(identity, hub)
        }
        void hub.addViewer(ws).catch((e) => {
          log.error(`takeover attach failed for "${identity}": ${(e as Error).message}`)
          ws.close()
        })
      })
      return
    }

    reject(socket, 404)
  })
}

function reject(socket: Duplex, status: number): void {
  const text = status === 403 ? 'Forbidden' : 'Not Found'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
