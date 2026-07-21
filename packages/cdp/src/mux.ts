// CdpMux - the mitigating multiplexer. One upstream WS to Chrome's /devtools/browser endpoint, N downstream
// clients, per-client command-id remapping, event routing by sessionId, a pluggable interceptor over every
// client→Chrome message, and a per-client authorization scope (the per-tab ACL). Proven in spike S1
// (docs/PRD.md §7); this is the promoted version.
//
// Two entry points:
//   • CdpMux.start()   - self-hosts a WebSocketServer on an ephemeral port and exposes `url` (spike S1 path).
//   • CdpMux.connect()  - upstream-only; the gateway feeds it already-upgraded sockets via attachClient()
//                         with a ClientScope, so raw CDP bypasses Nest's pipeline (docs/PRD.md §6).

import WebSocket, { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ClientMessage, InterceptContext, Interceptor } from './interceptor.ts'
import { unrestrictedScope, type ClientScope } from './scope.ts'

interface PendingUpstream {
  client?: DownstreamClient
  originalId?: number
  method?: string
  resolveInternal?: (result: any) => void
  rejectInternal?: (err: Error) => void
}

class DownstreamClient {
  constructor(
    readonly ws: WebSocket,
    readonly id: number,
    readonly scope: ClientScope,
  ) {}
  send(message: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }
}

export class CdpMux {
  private nextUpstreamId = 1
  private nextClientId = 1
  private readonly pending = new Map<number, PendingUpstream>()
  private readonly clients = new Set<DownstreamClient>()
  private readonly sessionOwner = new Map<string, DownstreamClient>()
  /** Ground truth of which CDP methods a client actually caused to reach Chrome (post-interception). */
  readonly forwardedMethods = new Set<string>()

  private constructor(
    private readonly upstream: WebSocket,
    private readonly interceptor: Interceptor,
    private readonly server?: WebSocketServer,
    /** Present only for the self-hosted start() path. */
    readonly url?: string,
  ) {
    this.upstream.on('message', (data) => this.onUpstreamMessage(data.toString()))
    // An upstream (Chrome) socket error/close must not crash the process: tear the mux down instead. `ws`
    // rethrows an 'error' with no listener.
    this.upstream.on('error', () => this.close())
    this.server?.on('connection', (ws) => this.attachClient(ws))
    this.server?.on('error', () => {})
  }

  private static async openUpstream(browserWsUrl: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  /** Self-hosted mux on an ephemeral loopback port (spike S1). Clients get the unrestricted scope. */
  static async start(opts: { browserWsUrl: string; interceptor: Interceptor }): Promise<CdpMux> {
    const upstream = await CdpMux.openUpstream(opts.browserWsUrl)
    const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return new CdpMux(upstream, opts.interceptor, server, `ws://127.0.0.1:${port}/`)
  }

  /** Upstream-only mux for gateway embedding: no own server. Feed it sockets via attachClient(ws, scope). */
  static async connect(opts: { browserWsUrl: string; interceptor: Interceptor }): Promise<CdpMux> {
    const upstream = await CdpMux.openUpstream(opts.browserWsUrl)
    return new CdpMux(upstream, opts.interceptor)
  }

  /** Register an (already-upgraded) downstream WebSocket as a client under the given ACL scope. */
  attachClient(ws: WebSocket, scope: ClientScope = unrestrictedScope): void {
    const client = new DownstreamClient(ws, this.nextClientId++, scope)
    this.clients.add(client)
    const drop = () => {
      this.clients.delete(client)
      for (const [sid, owner] of this.sessionOwner) if (owner === client) this.sessionOwner.delete(sid)
    }
    ws.on('message', (data) => void this.onClientMessage(client, data.toString()))
    ws.on('close', drop)
    // A downstream (agent/browser) socket error must not crash the process - drop the client. `ws` rethrows
    // an unhandled 'error'; the ensuing 'close' would double-drop, which is idempotent.
    ws.on('error', drop)
  }

  private async onClientMessage(client: DownstreamClient, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as ClientMessage
    // ACL: a scoped client may only attach to targets its lease grants. Enforced before interception so a
    // denied attach never reaches Chrome and never mints a session.
    const deniedTarget = this.aclDeniedTarget(client, msg)
    if (deniedTarget !== undefined) {
      client.send({ id: msg.id, error: { code: -32000, message: `target ${deniedTarget} not in this client's scope` } })
      return
    }
    const ctx: InterceptContext = {
      sessionId: msg.sessionId,
      sendUpstream: (method, params, sessionId) => this.internalCommand(method, params, sessionId),
      emitToClient: (message) => client.send(message),
    }
    const decision = await this.interceptor.onClientMessage(msg, ctx)
    if (decision.action === 'handled') return
    this.forward(client, msg)
  }

  /** Returns the disallowed targetId if this message is a target-attach outside the client's scope. */
  private aclDeniedTarget(client: DownstreamClient, msg: ClientMessage): string | undefined {
    if (msg.method !== 'Target.attachToTarget') return undefined
    const targetId = (msg.params as { targetId?: string } | undefined)?.targetId
    if (targetId && !client.scope.allows(targetId)) return targetId
    return undefined
  }

  private forward(client: DownstreamClient, msg: ClientMessage): void {
    if (msg.method) this.forwardedMethods.add(msg.method)
    const upstreamId = this.nextUpstreamId++
    this.pending.set(upstreamId, { client, originalId: msg.id, method: msg.method })
    this.upstream.send(JSON.stringify({ ...msg, id: upstreamId }))
  }

  private internalCommand(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const upstreamId = this.nextUpstreamId++
    return new Promise((resolve, reject) => {
      this.pending.set(upstreamId, { resolveInternal: resolve, rejectInternal: reject })
      const payload: Record<string, unknown> = { id: upstreamId, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.upstream.send(JSON.stringify(payload))
    })
  }

  private onUpstreamMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number
      method?: string
      params?: Record<string, any>
      sessionId?: string
      result?: Record<string, any>
      error?: { message: string }
    }

    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)

      if (entry.resolveInternal) {
        if (msg.error) entry.rejectInternal!(new Error(msg.error.message))
        else entry.resolveInternal(msg.result)
        return
      }
      if (entry.method === 'Target.attachToTarget' && msg.result?.sessionId && entry.client) {
        this.sessionOwner.set(msg.result.sessionId, entry.client)
      }
      // ACL: never let a scoped client enumerate targets outside its lease.
      if (entry.method === 'Target.getTargets' && entry.client && msg.result?.targetInfos) {
        msg.result.targetInfos = this.filterTargetInfos(entry.client, msg.result.targetInfos)
      }
      entry.client?.send({ ...msg, id: entry.originalId })
      return
    }

    if (msg.method) this.routeUpstreamEvent(msg, raw)
  }

  /** Route/broadcast an upstream event, honouring sessionId ownership and per-target ACLs. */
  private routeUpstreamEvent(msg: { method?: string; params?: Record<string, any>; sessionId?: string }, raw: string): void {
    const sid = msg.sessionId
    if (sid) {
      const owner = this.sessionOwner.get(sid)
      if (owner) {
        if (owner.ws.readyState === WebSocket.OPEN) owner.ws.send(raw)
        return
      }
      // Fall through: an unowned session's events go only to unscoped (control) clients.
      for (const c of this.clients) if (c.scope === unrestrictedScope && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
      return
    }

    // Browser-level (non-sessioned) events. Target lifecycle events are per-target ACL'd; anything else is
    // broadcast to every client (each still command-id-isolated).
    const target = this.eventTargetId(msg)
    if (msg.method === 'Target.attachedToTarget' && target && msg.params?.sessionId) {
      // Flat-mode auto-attach: assign session ownership to the unique scope that leases this target, then
      // deliver only to that client. Non-leased auto-attaches reach only unscoped control clients.
      const owner = this.clientForTarget(target)
      if (owner) {
        this.sessionOwner.set(msg.params.sessionId as string, owner)
        if (owner.ws.readyState === WebSocket.OPEN) owner.ws.send(raw)
        return
      }
      for (const c of this.clients) if (c.scope === unrestrictedScope && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
      return
    }

    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue
      if (target !== undefined && !c.scope.allows(target)) continue
      c.ws.send(raw)
    }
  }

  /** targetId carried by a target-lifecycle event, or undefined for events that aren't target-scoped. */
  private eventTargetId(msg: { method?: string; params?: Record<string, any> }): string | undefined {
    switch (msg.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        return msg.params?.targetInfo?.targetId as string | undefined
      case 'Target.attachedToTarget':
        return msg.params?.targetInfo?.targetId as string | undefined
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed':
        return msg.params?.targetId as string | undefined
      default:
        return undefined
    }
  }

  private filterTargetInfos(client: DownstreamClient, infos: Array<{ targetId?: string }>): Array<{ targetId?: string }> {
    if (client.scope === unrestrictedScope) return infos
    return infos.filter((t) => t.targetId !== undefined && client.scope.allows(t.targetId))
  }

  /** The single scoped client that leases `targetId`, if any (leasing invariant: at most one). */
  private clientForTarget(targetId: string): DownstreamClient | undefined {
    for (const c of this.clients) if (c.scope !== unrestrictedScope && c.scope.allows(targetId)) return c
    return undefined
  }

  close(): void {
    for (const c of this.clients) c.ws.close()
    this.server?.close()
    this.upstream.close()
  }
}
