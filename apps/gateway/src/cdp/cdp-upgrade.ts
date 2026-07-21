// Raw-WS upgrade wiring - the architectural crux (PRD §6). NestJS owns the HTTP + MCP surface, but CDP frames
// must NOT traverse Nest's DI/guard/interceptor pipeline: they are high-volume binary-ish JSON routed by the
// mux, not Nest routes. So we bind our own handler to the underlying http.Server's `upgrade` event (ahead of
// anything Nest does with upgrades) and hand matched sockets straight to the per-identity CdpMux / TakeoverHub.
//
//   /cdp/<identity>/<agentId>?token=…  → agent raw-CDP, attached under the live per-tab ACL scope
//   /takeover/<identity>/ws            → human live-view + input (screencast fan-out)
//
// Path carries the resource (which browser, attaching as whom); the query carries only the credential.
//
// Both are authenticated here rather than by a Nest guard, and that is not a shortcut: a WebSocket handshake
// arrives on the http.Server's `upgrade` event, which Express - and therefore every Nest guard, pipe, and
// interceptor - never sees. Rejecting before the upgrade completes also gives a real `HTTP/1.1 401`, which is
// a better failure than accepting a socket and closing it. The two paths use DIFFERENT credentials on purpose:
//
//   • /takeover → the global access token. It is an operator surface (live view + trusted input), so it is
//     gated by the same credential as the dashboard and the API.
//   • /cdp      → the per-agent derived token. An agent must NOT hold the operator credential; its token
//     authorises exactly one (identity, agent) pair and nothing else.
//
// Any other upgrade is left untouched when `rejectUnmatched` is false - in dev the Vite HMR proxy registers
// its OWN 'upgrade' listener (http-proxy-middleware, path-filtered to SPA/HMR) and handles it; touching the
// socket here would double-handle it and corrupt the frames. In prod nothing else handles it, so reject.

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { Logger } from '@nestjs/common'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CdpGatewayService } from '../gateway/gateway.service.ts'
import { tokenFromRequest, verifyAccessToken } from '../auth/auth.ts'
import { TakeoverHub } from '../takeover/takeover.ts'

// `/cdp/<identity>/<agentId>` - both are *resource* coordinates (which browser, attaching as whom), so they
// live in the path; only the credential rides in the query. agentId is percent-encoded because, unlike
// identity, it is an opaque caller-chosen string with no charset contract.
const CDP_RE = /^\/cdp\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([^/]{1,256})$/
const TAKEOVER_RE = /^\/takeover\/([a-z0-9]+(?:-[a-z0-9]+)*)\/ws$/

/** Percent-decode a path segment, treating malformed input as absent rather than throwing on the socket. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/** @param rejectUnmatched reject upgrades we don't own (prod); false in dev leaves them for the Vite proxy. */
export function mountGatewayUpgrades(
  server: Server,
  service: CdpGatewayService,
  { rejectUnmatched = true }: { rejectUnmatched?: boolean } = {},
): void {
  const log = new Logger('CdpUpgrade')
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
  wss.on('error', (e) => log.warn(`ws server error: ${e.message}`))
  const takeoverHubs = new Map<string, TakeoverHub>()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Guard the RAW upgrade socket: a reset/protocol error on it (common on the dev HMR proxy path, or a
    // client that vanishes mid-handshake) rethrows fatally if unhandled - an unlistened socket error is what
    // takes the whole gateway down. This keeps it contained to the one connection.
    socket.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    const cdp = CDP_RE.exec(path)
    if (cdp) {
      const identity = cdp[1]
      const agent = decodeSegment(cdp[2])
      const token = url.searchParams.get('token') ?? undefined
      let resolved
      try {
        resolved = service.resolveCdpUpgrade(identity, agent, token)
      } catch (e) {
        // The message names the identity and agent but never the token - this line is the one thing that runs
        // on every rejected attach, so it is exactly where a credential would end up in the logs forever.
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
      // Cookie first: the dashboard is the expected client and `new WebSocket()` cannot set an Authorization
      // header, so the cookie set at login is how a browser authenticates here. The query param is the fallback
      // for a non-browser viewer, which is also why it must never be logged.
      const presented = tokenFromRequest(req) ?? url.searchParams.get('token') ?? undefined
      if (!verifyAccessToken(presented)) {
        log.warn(`takeover upgrade rejected for "${identity}": missing or invalid access token`)
        return reject(socket, 401)
      }
      if (!service.isRunning(identity)) return reject(socket, 404)
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        // Rebuild the hub if the identity was stopped and restarted - the old one holds a dead control client.
        const control = service.controlClient(identity)
        let hub = takeoverHubs.get(identity)
        if (hub && !hub.usesClient(control)) {
          hub.dispose()
          hub = undefined
        }
        if (!hub) {
          hub = new TakeoverHub(control, () => service.listTargets(identity))
          takeoverHubs.set(identity, hub)
        }
        void hub.addViewer(ws).catch((e) => {
          log.error(`takeover attach failed for "${identity}": ${(e as Error).message}`)
          ws.close()
        })
      })
      return
    }

    // Not ours. In dev, leave it for the Vite HMR proxy's own 'upgrade' listener (do NOT touch the socket).
    if (rejectUnmatched) reject(socket, 404)
  })
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }

function reject(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
