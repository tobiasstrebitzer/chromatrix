// Ground-truth leak probe. Connects DIRECTLY to Chrome (bypassing the mux) as an independent observer,
// and deliberately never enables the Runtime domain itself. It arms the classic getter-trap in the page's
// MAIN world and checks whether the getter fired — which happens iff some *other* attached session has
// Runtime.enable active (i.e. the consumer's CDP presence leaked through the proxy).
//
// Runtime.evaluate works without Runtime.enable (enable only controls event delivery), so the probe can
// measure without perturbing what it measures.

import { CdpClient } from './cdp-client.ts'

const ARM_TRAP = `
  (function () {
    window.__chromatrixLeak = false;
    var trap = {};
    Object.defineProperty(trap, 'id', {
      enumerable: true,
      get: function () { window.__chromatrixLeak = true; return 1; },
    });
    // If any session has Runtime.enable, Chrome serializes this console arg's preview,
    // invoking the getter above. rebrowser-bot-detector uses this exact technique.
    console.debug('chromatrix-cdp-leak-probe', trap);
    return 'armed';
  })()
`

export interface ProbeResult {
  leakDetected: boolean
  note: string
}

export async function runProbe(browserWsUrl: string, targetId: string): Promise<ProbeResult> {
  const client = await CdpClient.connect(browserWsUrl)
  try {
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    // Intentionally NO Runtime.enable here.
    await client.send('Runtime.evaluate', { expression: ARM_TRAP }, sessionId)
    await new Promise((r) => setTimeout(r, 400))
    const read = await client.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'window.__chromatrixLeak === true', returnByValue: true },
      sessionId,
    )
    const leakDetected = read.result?.value === true
    return {
      leakDetected,
      note: leakDetected
        ? 'getter fired → a live session has Runtime.enable (CDP presence detectable)'
        : 'getter never fired → no session had Runtime enabled (leak neutralised)',
    }
  } finally {
    client.close()
  }
}

export async function closeTarget(browserWsUrl: string, targetId: string): Promise<void> {
  const client = await CdpClient.connect(browserWsUrl)
  try {
    await client.send('Target.closeTarget', { targetId })
  } catch {
    /* best effort */
  } finally {
    client.close()
  }
}
