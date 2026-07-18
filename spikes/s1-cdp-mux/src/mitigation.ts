// Interception policies for the mux. This is the crux of spike S1 (docs/PRD.md §7): can we neutralise the
// Runtime.enable detection leak *at the proxy* for an unmodified raw-CDP consumer, while that consumer can
// still evaluate JS? Two policies below let the runner A/B a transparent proxy vs a mitigating one.

export interface ClientMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface InterceptContext {
  /** sessionId of the client message being handled (flat-mode). */
  sessionId?: string
  /** Issue a mux-internal CDP command upstream (not surfaced to the client). */
  sendUpstream: (method: string, params?: object, sessionId?: string) => Promise<any>
  /** Push a synthetic CDP message (event or command response) down to this client. */
  emitToClient: (message: object) => void
}

export type InterceptDecision = { action: 'forward' } | { action: 'handled' }

export interface Interceptor {
  readonly name: string
  onClientMessage(msg: ClientMessage, ctx: InterceptContext): Promise<InterceptDecision>
}

/** Baseline: byte-for-byte passthrough (what Steel/Browserless do). Establishes the leak's ground truth. */
export const transparentInterceptor: Interceptor = {
  name: 'transparent',
  async onClientMessage() {
    return { action: 'forward' }
  },
}

/**
 * Level-2 mitigation: never let `Runtime.enable` reach Chrome. Instead, emulate the slice of the Runtime
 * domain an unmodified consumer needs — a single execution context to evaluate in — by minting a real
 * isolated world (`Page.createIsolatedWorld`) and synthesizing the `Runtime.executionContextCreated`
 * event the consumer expects. Because Chrome's Runtime domain is never enabled on any session, it emits no
 * console previews for the main world, so the classic getter-trap (`console.debug({get id(){...}})`) never
 * fires. This is the rebrowser "alwaysIsolated" idea moved from the client library into the proxy.
 */
export const runtimeEnableSuppressInterceptor: Interceptor = {
  name: 'runtime-enable-suppress',
  async onClientMessage(msg, ctx) {
    if (msg.method !== 'Runtime.enable') return { action: 'forward' }
    const sid = msg.sessionId

    // Main frame for this session. Page.getFrameTree does not require Page.enable.
    const { frameTree } = await ctx.sendUpstream('Page.getFrameTree', {}, sid)
    const frameId = frameTree.frame.id as string

    // A real execution context we can evaluate in, in an isolated world.
    const { executionContextId } = await ctx.sendUpstream(
      'Page.createIsolatedWorld',
      // NOTE: the CDP param really is spelled "grantUniveralAccess" (protocol typo).
      { frameId, worldName: '__chromatrix_mux__', grantUniveralAccess: true },
      sid,
    )

    // Hand the consumer the context it was waiting for, then ack the enable so its call resolves.
    ctx.emitToClient({
      method: 'Runtime.executionContextCreated',
      sessionId: sid,
      params: {
        context: {
          id: executionContextId,
          origin: '',
          name: '__chromatrix_mux__',
          uniqueId: `mux-${executionContextId}`,
          auxData: { isDefault: true, type: 'default', frameId },
        },
      },
    })
    ctx.emitToClient({ id: msg.id, sessionId: sid, result: {} })
    return { action: 'handled' }
  },
}
