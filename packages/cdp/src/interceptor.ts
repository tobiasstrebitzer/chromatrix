// The interception contract for the mux: a pluggable policy over every client→Chrome CDP message. This is
// the seam that makes the gateway *mitigating* rather than a transparent proxy. Concrete
// fidelity policies (e.g. Runtime.enable suppression) live in @chromatrix/fidelity and implement Interceptor.

export interface ClientMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface InterceptContext {
  /** sessionId of the client message being handled (flat-mode). */
  sessionId?: string
  /**
   * True when this connection opted OUT of fidelity mitigations (framework-compat mode).
   *
   * Framework clients (Playwright) drive the Runtime domain's execution-context lifecycle, which a mitigation
   * that suppresses `Runtime.enable` would have to emulate in full - every world, every navigation. Rather
   * than emulate it half-way and hang the client, such a connection asks for the unmitigated protocol. This
   * is a per-connection choice, not a global one: the default path stays mitigated. See docs/FINDINGS.md.
   */
  compat: boolean
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

/** Byte-for-byte passthrough (what Steel/Browserless do). The baseline; not fidelity-mitigating on its own. */
export const transparentInterceptor: Interceptor = {
  name: 'transparent',
  async onClientMessage() {
    return { action: 'forward' }
  },
}
