// Runtime.enable suppression — a stealth Interceptor for the CdpMux. Never lets `Runtime.enable` reach
// Chrome; instead mints a real isolated world and synthesizes the executionContextCreated event the
// consumer expects, so an unmodified raw-CDP consumer still evaluates while Chrome's Runtime domain is never
// enabled. Proven in spike S1 (docs/PRD.md §7).
//
// Note on Chrome 150+: the classic in-page getter-trap leak is already closed upstream, so this is now
// defense-in-depth / handshake-surface reduction (older builds, non-getter tells, the
// Runtime.enable+Target.setAutoAttach sequence anti-bots key on) rather than closing an active in-page leak.

import type { Interceptor } from '@chromatrix/cdp'

export const runtimeEnableSuppressInterceptor: Interceptor = {
  name: 'runtime-enable-suppress',
  async onClientMessage(msg, ctx) {
    if (msg.method !== 'Runtime.enable') return { action: 'forward' }
    const sid = msg.sessionId

    // Main frame for this session. Page.getFrameTree does not require Page.enable.
    const { frameTree } = await ctx.sendUpstream('Page.getFrameTree', {}, sid)
    const frameId = frameTree.frame.id as string

    // A real execution context in an isolated world — evaluation works here, and because we never forward
    // Runtime.enable, Chrome enables no Runtime domain on any session.
    const { executionContextId } = await ctx.sendUpstream(
      'Page.createIsolatedWorld',
      // NOTE: the CDP param really is spelled "grantUniveralAccess" (protocol typo).
      { frameId, worldName: '__chromatrix_mux__', grantUniveralAccess: true },
      sid,
    )

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
