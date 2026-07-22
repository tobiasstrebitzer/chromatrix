// CdpMux - the mitigating multiplexer. One upstream WS to Chrome's /devtools/browser endpoint, N downstream
// clients, per-client command-id remapping, event routing by sessionId, a pluggable interceptor over every
// client→Chrome message, and a per-client authorization scope (the per-tab ACL). Proven in spike S1
// (docs/FINDINGS.md, S1); this is the promoted version.
//
// Two entry points:
//   • CdpMux.start()   - self-hosts a WebSocketServer on an ephemeral port and exposes `url` (spike S1 path).
//   • CdpMux.connect()  - upstream-only; the gateway feeds it already-upgraded sockets via attachClient()
//                         with a ClientScope, so raw CDP bypasses Nest's pipeline.

import WebSocket, { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { ClientMessage, InterceptContext, Interceptor } from './interceptor.ts'
import { unrestrictedScope, type ClientScope } from './scope.ts'

/** How long an unowned `Target.attachedToTarget` is held for a lease that may be moments away. */
const ORPHAN_ATTACH_TTL_MS = 10_000
/** Deadline for a mux-internal upstream command (see internalCommand). */
const INTERNAL_COMMAND_TIMEOUT_MS = 15_000
/** How long a replay waits for auto-attach to mint a session for a just-leased tab (see upstreamSessionFor). */
const AUTO_ATTACH_WAIT_MS = 3_000

interface PendingUpstream {
  client?: DownstreamClient
  originalId?: number
  method?: string
  resolveInternal?: (result: any) => void
  rejectInternal?: (err: Error) => void
}

class DownstreamClient {
  /**
   * Serializes this client's messages. The mux does async work before forwarding (an interceptor round-trip,
   * a synthesized replay), and `ws.on('message')` is fire-and-forget - so without this queue a message that
   * awaits is overtaken by the next one and the client's commands reach Chrome out of order. That reordering
   * is what hung agent-browser in the first (reverted) attempt at this fix.
   */
  queue: Promise<void> = Promise.resolve()

  constructor(
    readonly ws: WebSocket,
    readonly id: number,
    readonly scope: ClientScope,
    /** Framework-compat: this connection asked for the unmitigated protocol (see InterceptContext.compat). */
    readonly compat: boolean = false,
  ) {}
  send(message: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }
  get scoped(): boolean {
    return this.scope !== unrestrictedScope
  }
}

export class CdpMux {
  private nextUpstreamId = 1
  private nextClientId = 1
  private readonly pending = new Map<number, PendingUpstream>()
  private readonly clients = new Set<DownstreamClient>()
  private readonly sessionOwner = new Map<string, DownstreamClient>()
  /** targetId → an attach event seen before the target had an owner (see rememberOrphanAttach). */
  private readonly orphanAttaches = new Map<string, { sessionId: string; raw: string; timer: NodeJS.Timeout }>()
  /** targetId → the upstream session auto-attach minted for it. The table replayAutoAttach reads from. */
  private readonly upstreamSessions = new Map<string, { sessionId: string; targetInfo: object }>()
  /** Targets whose next upstream attach event we caused ourselves and must not deliver twice. */
  private readonly suppressNextAttachEvent = new Set<string>()
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
    const mux = new CdpMux(upstream, opts.interceptor, server, `ws://127.0.0.1:${port}/`)
    await mux.primeAutoAttach()
    return mux
  }

  /** Upstream-only mux for gateway embedding: no own server. Feed it sockets via attachClient(ws, scope). */
  static async connect(opts: { browserWsUrl: string; interceptor: Interceptor }): Promise<CdpMux> {
    const upstream = await CdpMux.openUpstream(opts.browserWsUrl)
    const mux = new CdpMux(upstream, opts.interceptor)
    await mux.primeAutoAttach()
    return mux
  }

  /**
   * Take ownership of the upstream auto-attach latch, before any client can trip it.
   *
   * Auto-attach is per-connection state, and this mux is the only connection - so whichever client asked for
   * it first would both latch it AND consume Chrome's one-shot `Target.attachedToTarget` replay, leaving every
   * later client with nothing (the bug) while ALSO racing the synthesized replay we now send it (a duplicate
   * target, which is fatal to Playwright). Latching it here makes the upstream state a constant: Chrome's
   * replay happens once, with no clients attached, and from then on every client's `setAutoAttach` is answered
   * entirely by synthesis. One source of attach events per client, never two.
   *
   * `waitForDebuggerOnStart` is deliberately FALSE regardless of what any client later asks for: a paused new
   * target would wedge the orchestrator's own `Target.createTarget` (its control connection is not the one
   * that would resume it), so tab allocation itself would hang. A client that wants its own sub-targets paused
   * still gets that - its page-level `setAutoAttach` (the one carrying a sessionId) is forwarded untouched.
   */
  private async primeAutoAttach(): Promise<void> {
    await this.internalCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {
      /* an upstream that refuses this still works for explicitly-attaching clients (agent-browser) */
    })
  }

  /** Register an (already-upgraded) downstream WebSocket as a client under the given ACL scope. */
  attachClient(ws: WebSocket, scope: ClientScope = unrestrictedScope, opts: { compat?: boolean } = {}): void {
    const client = new DownstreamClient(ws, this.nextClientId++, scope, opts.compat ?? false)
    this.clients.add(client)
    const drop = () => {
      this.clients.delete(client)
      for (const [sid, owner] of this.sessionOwner) if (owner === client) this.sessionOwner.delete(sid)
    }
    // Chained, not fire-and-forget: see DownstreamClient.queue. A message that throws must not poison the
    // chain for every later message, so each link absorbs its own failure into an error response.
    ws.on('message', (data) => {
      const raw = data.toString()
      client.queue = client.queue.then(() => this.onClientMessage(client, raw)).catch((e) => this.failMessage(client, raw, e as Error))
    })
    ws.on('close', drop)
    // A downstream (agent/browser) socket error must not crash the process - drop the client. `ws` rethrows
    // an unhandled 'error'; the ensuing 'close' would double-drop, which is idempotent.
    ws.on('error', drop)
  }

  /** Answer a command whose handling threw, so a caller waiting on that id fails fast instead of hanging. */
  private failMessage(client: DownstreamClient, raw: string, err: Error): void {
    let id: number | undefined
    try {
      id = (JSON.parse(raw) as ClientMessage).id
    } catch {
      return // unparseable frame: nothing to answer
    }
    if (id !== undefined) client.send({ id, error: { code: -32000, message: err.message } })
  }

  private async onClientMessage(client: DownstreamClient, raw: string): Promise<void> {
    const msg = JSON.parse(raw) as ClientMessage
    // ACL: a scoped client may only act on targets its lease grants. Enforced before interception so a denied
    // command never reaches Chrome and never mints a session.
    const deniedTarget = this.aclDeniedTarget(client, msg)
    if (deniedTarget !== undefined) {
      client.send({ id: msg.id, error: { code: -32000, message: `target ${deniedTarget} not in this client's scope` } })
      return
    }
    if (await this.handleScopedTargetCommand(client, msg)) return
    const ctx: InterceptContext = {
      sessionId: msg.sessionId,
      compat: client.compat,
      sendUpstream: (method, params, sessionId) => this.internalCommand(method, params, sessionId),
      emitToClient: (message) => client.send(message),
    }
    const decision = await this.interceptor.onClientMessage(msg, ctx)
    if (decision.action === 'handled') return
    this.forward(client, msg)
  }

  /**
   * Target commands that name a targetId, and so must be ACL'd. `Target.attachToTarget` is the one that mints
   * a session, but the others are just as much a cross-tenant reach: closing, activating, or reading the info
   * of a *peer agent's* tab is not this client's business either.
   */
  private static readonly TARGET_ID_COMMANDS = new Set([
    'Target.attachToTarget',
    'Target.closeTarget',
    'Target.activateTarget',
    'Target.getTargetInfo',
    'Target.exposeDevToolsProtocol',
  ])

  /** Returns the disallowed targetId if this message names a target outside the client's scope. */
  private aclDeniedTarget(client: DownstreamClient, msg: ClientMessage): string | undefined {
    if (!msg.method || !CdpMux.TARGET_ID_COMMANDS.has(msg.method)) return undefined
    const targetId = (msg.params as { targetId?: string } | undefined)?.targetId
    // `Target.getTargetInfo` with no targetId asks about the connection itself - always the client's own.
    if (!targetId) return undefined
    return client.scope.allows(targetId) ? undefined : targetId
  }

  /**
   * Target commands a SCOPED client cannot simply have forwarded, because the upstream answer would be wrong
   * for it. Returns true if the command was fully handled here.
   *
   * The unifying problem is that this mux holds ONE upstream connection shared by every client, so any command
   * whose value is a one-shot *replay* of browser state is consumed by whoever asks first - and any command
   * that mutates the target set does so outside the leasing model that the ACL reads from.
   */
  private async handleScopedTargetCommand(client: DownstreamClient, msg: ClientMessage): Promise<boolean> {
    if (!client.scoped || !msg.method) return false
    const params = (msg.params ?? {}) as Record<string, unknown>

    // Browser-level auto-attach (no sessionId). A page-level one (with a sessionId) governs that page's own
    // sub-targets - iframes, workers - and is forwarded untouched.
    if (msg.method === 'Target.setAutoAttach' && !msg.sessionId && params.autoAttach === true) {
      await this.replayAutoAttach(client, msg)
      return true
    }
    if (msg.method === 'Target.createTarget') {
      await this.createAndAdopt(client, msg)
      return true
    }
    if (msg.method === 'Target.closeTarget' && typeof params.targetId === 'string') {
      await this.closeAndRelease(client, msg, params.targetId)
      return true
    }
    return false
  }

  /**
   * Answer `Target.setAutoAttach` per-client instead of forwarding it.
   *
   * Auto-attach is LATCHED on our single upstream socket: Chrome replays `Target.attachedToTarget` for the
   * existing targets exactly once, to the connection that first turned it on. Every later client - a second
   * agent, or the same agent reconnecting after a detach - forwards the same command, gets a bare `{}` with no
   * replay, and concludes the browser has no pages at all. Playwright builds its page registry from that
   * replay, which is why it saw zero pages on every connection after the first.
   *
   * So: ensure it is on upstream, then synthesize the replay for exactly the targets this client leases.
   */
  private async replayAutoAttach(client: DownstreamClient, msg: ClientMessage): Promise<void> {
    // Nothing goes upstream. primeAutoAttach() already latched auto-attach, so every page target ALREADY has
    // an upstream session and we replay from the table of them. Issuing `Target.attachToTarget` here instead
    // would make Chrome emit its own `Target.attachedToTarget`, which - now that the target has an owner -
    // gets routed to this very client on top of the synthesized one. Playwright treats a target announced
    // twice as fatal ("Duplicate target"), so the replay must be the ONLY announcement.
    for (const targetId of client.scope.allowedTargets()) {
      const session = await this.upstreamSessionFor(targetId)
      if (!session) continue
      this.sessionOwner.set(session.sessionId, client)
      client.send({
        method: 'Target.attachedToTarget',
        params: { sessionId: session.sessionId, targetInfo: session.targetInfo, waitingForDebugger: false },
      })
    }
    client.send({ id: msg.id, result: {} })
  }

  /**
   * The upstream session for a target, waiting briefly for auto-attach to produce one.
   *
   * A tab leased moments ago may not have been auto-attached yet - the lease is registered on the control
   * connection's `Target.createTarget` response, which can land before Chrome's attach event on ours. The wait
   * is what makes "allocate a tab, immediately connect Playwright" deterministic rather than a race.
   */
  private async upstreamSessionFor(targetId: string): Promise<{ sessionId: string; targetInfo: object } | undefined> {
    const deadline = Date.now() + AUTO_ATTACH_WAIT_MS
    for (;;) {
      const known = this.upstreamSessions.get(targetId)
      if (known) return known
      if (Date.now() >= deadline) break
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25)
        t.unref?.()
      })
    }
    // Auto-attach never fired for it (not a page target, or it died). Fall back to an explicit attach, and
    // swallow the event that attach will emit so this still announces the target exactly once.
    this.suppressNextAttachEvent.add(targetId)
    try {
      const { sessionId } = await this.internalCommand('Target.attachToTarget', { targetId, flatten: true })
      const { targetInfo } = await this.internalCommand('Target.getTargetInfo', { targetId })
      const session = { sessionId, targetInfo }
      this.upstreamSessions.set(targetId, session)
      return session
    } catch {
      this.suppressNextAttachEvent.delete(targetId)
      return undefined // target died between the lease and the replay; the client simply doesn't see it
    }
  }

  /**
   * `Target.createTarget` from a scoped client (Playwright's `newPage()`): create it, then LEASE it to that
   * client before answering. Without the lease the tab it just asked for belongs to nobody, so the ACL routes
   * the tab's own `Target.attachedToTarget` away from it and no lease will ever reap the tab.
   */
  private async createAndAdopt(client: DownstreamClient, msg: ClientMessage): Promise<void> {
    let result: { targetId?: string }
    try {
      result = await this.internalCommand('Target.createTarget', msg.params ?? {})
    } catch (e) {
      client.send({ id: msg.id, error: { code: -32000, message: (e as Error).message } })
      return
    }
    if (result?.targetId) {
      client.scope.adopt?.(result.targetId)
      this.deliverOrphanAttach(result.targetId, client)
    }
    client.send({ id: msg.id, result })
  }

  /** `Target.closeTarget` from a scoped client: close it, then drop the lease (the tab is already gone). */
  private async closeAndRelease(client: DownstreamClient, msg: ClientMessage, targetId: string): Promise<void> {
    try {
      const result = await this.internalCommand('Target.closeTarget', msg.params ?? {})
      client.scope.release?.(targetId)
      client.send({ id: msg.id, result })
    } catch (e) {
      client.send({ id: msg.id, error: { code: -32000, message: (e as Error).message } })
    }
  }

  private forward(client: DownstreamClient, msg: ClientMessage): void {
    if (msg.method) this.forwardedMethods.add(msg.method)
    const upstreamId = this.nextUpstreamId++
    this.pending.set(upstreamId, { client, originalId: msg.id, method: msg.method })
    this.upstream.send(JSON.stringify({ ...msg, id: upstreamId }))
  }

  /**
   * A mux-internal upstream command, never surfaced to a client.
   *
   * Time-boxed, unlike a forwarded command: these are awaited on a client's serialized queue, so an upstream
   * that never answers (a crashed target, a wedged renderer) would block every later message from that client
   * forever. Failing the one command instead surfaces as an error on that command alone.
   */
  private internalCommand(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const upstreamId = this.nextUpstreamId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(upstreamId)
        reject(new Error(`upstream ${method} timed out after ${INTERNAL_COMMAND_TIMEOUT_MS}ms`))
      }, INTERNAL_COMMAND_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(upstreamId, {
        resolveInternal: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        rejectInternal: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
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
      // Record it first, whoever it ends up going to: this table is what replayAutoAttach answers a later
      // client from, and a target attached while nobody was connected is exactly the common case.
      this.upstreamSessions.set(target, {
        sessionId: msg.params.sessionId as string,
        targetInfo: msg.params.targetInfo as object,
      })
      // Our own doing (upstreamSessionFor's fallback attach), already announced by synthesis - drop it.
      if (this.suppressNextAttachEvent.delete(target)) return
      // Flat-mode auto-attach: assign session ownership to the unique scope that leases this target, then
      // deliver only to that client. Non-leased auto-attaches reach only unscoped control clients.
      const owner = this.clientForTarget(target)
      if (owner) {
        this.sessionOwner.set(msg.params.sessionId as string, owner)
        if (owner.ws.readyState === WebSocket.OPEN) owner.ws.send(raw)
        return
      }
      // Unowned - but a client's own `Target.createTarget` may still be in flight, in which case this event
      // is that client's and the lease is milliseconds away. Hold it so adoption can deliver it.
      this.rememberOrphanAttach(target, msg.params.sessionId as string, raw)
      for (const c of this.clients) if (c.scope === unrestrictedScope && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw)
      return
    }

    // A target that is gone must leave no session behind for a later client to be handed.
    if (msg.method === 'Target.targetDestroyed' && target) {
      this.upstreamSessions.delete(target)
      this.suppressNextAttachEvent.delete(target)
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const detached = msg.params?.targetId as string | undefined
      if (detached) this.upstreamSessions.delete(detached)
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

  /**
   * Park an `attachedToTarget` that arrived before its target had an owner. Chrome emits it as soon as the
   * target exists, which for a client-created tab can beat our own `Target.createTarget` response; dropping it
   * would leave that client with a page it can never drive. Short-lived: an attach nobody claims is simply a
   * target nobody leases, and the buffer must not become a second, silent target registry.
   */
  private rememberOrphanAttach(targetId: string, sessionId: string, raw: string): void {
    this.orphanAttaches.get(targetId)?.timer.unref?.()
    const timer = setTimeout(() => this.orphanAttaches.delete(targetId), ORPHAN_ATTACH_TTL_MS)
    timer.unref?.()
    this.orphanAttaches.set(targetId, { sessionId, raw, timer })
  }

  /** Hand a parked attach to the client that has just been granted the target. */
  private deliverOrphanAttach(targetId: string, client: DownstreamClient): void {
    const parked = this.orphanAttaches.get(targetId)
    if (!parked) return
    clearTimeout(parked.timer)
    this.orphanAttaches.delete(targetId)
    this.sessionOwner.set(parked.sessionId, client)
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(parked.raw)
  }

  close(): void {
    for (const { timer } of this.orphanAttaches.values()) clearTimeout(timer)
    this.orphanAttaches.clear()
    for (const c of this.clients) c.ws.close()
    this.server?.close()
    this.upstream.close()
  }
}
