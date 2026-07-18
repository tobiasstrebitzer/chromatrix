// The interception contract for the mux: a pluggable policy over every client→Chrome CDP message. This is
// the seam that makes the gateway *mitigating* rather than a transparent proxy (docs/PRD.md §3). Concrete
// stealth policies (e.g. Runtime.enable suppression) live in @chromatrix/stealth and implement Interceptor.

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

/** Byte-for-byte passthrough (what Steel/Browserless do). The baseline; not stealth-mitigating on its own. */
export const transparentInterceptor: Interceptor = {
  name: 'transparent',
  async onClientMessage() {
    return { action: 'forward' }
  },
}
