// CdpMux — the mitigating multiplexer prototype. One upstream WS to Chrome's /devtools/browser endpoint,
// N downstream clients, per-client command-id remapping, event routing by sessionId, and a pluggable
// interceptor over every client->Chrome message. This is the throwaway S1 version; once proven it is
// promoted into packages/cdp (docs/PRD.md §6/§7).

import WebSocket, { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ClientMessage, InterceptContext, Interceptor } from './mitigation.ts'

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
    private readonly server: WebSocketServer,
    private readonly interceptor: Interceptor,
    readonly url: string,
  ) {
    this.upstream.on('message', (data) => this.onUpstreamMessage(data.toString()))
    this.server.on('connection', (ws) => this.onClientConnect(ws))
  }

  static async start(opts: { browserWsUrl: string; interceptor: Interceptor }): Promise<CdpMux> {
    const upstream = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(opts.browserWsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
    const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    return new CdpMux(upstream, server, opts.interceptor, `ws://127.0.0.1:${port}/`)
  }

  private onClientConnect(ws: WebSocket): void {
    const client = new DownstreamClient(ws, this.nextClientId++)
    this.clients.add(client)
    ws.on('message', (data) => void this.onClientMessage(client, data.toString()))
    ws.on('close', () => {
      this.clients.delete(client)
      for (const [sid, owner] of this.sessionOwner) if (owner === client) this.sessionOwner.delete(sid)
    })
  }

  private async onClientMessage(client: DownstreamClient, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as ClientMessage
    const ctx: InterceptContext = {
      sessionId: msg.sessionId,
      sendUpstream: (method, params, sessionId) => this.internalCommand(method, params, sessionId),
      emitToClient: (message) => client.send(message),
    }
    const decision = await this.interceptor.onClientMessage(msg, ctx)
    if (decision.action === 'handled') return
    this.forward(client, msg)
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
      // Client response: learn sessionId ownership from explicit attaches, then route back with orig id.
      if (entry.method === 'Target.attachToTarget' && msg.result?.sessionId && entry.client) {
        this.sessionOwner.set(msg.result.sessionId, entry.client)
      }
      entry.client?.send({ ...msg, id: entry.originalId })
      return
    }

    // Event: route by top-level sessionId to its owner, else broadcast (browser-level).
    if (msg.method) {
      const sid = msg.sessionId
      if (sid) {
        const owner = this.sessionOwner.get(sid)
        if (owner) {
          owner.ws.send(raw)
          return
        }
      }
      for (const c of this.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
    }
  }

  close(): void {
    for (const c of this.clients) c.ws.close()
    this.server.close()
    this.upstream.close()
  }
}
