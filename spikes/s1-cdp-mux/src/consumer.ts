// The "naive" raw-CDP consumer — a stand-in for vercel-labs/agent-browser and other unmodified raw-CDP
// tools. It does the ordinary thing: create a tab, attach (flat), Page.enable, Runtime.enable, then
// evaluate. Runtime.enable is exactly the call that leaks under a transparent proxy. We keep the
// connection OPEN (via the returned close()) so the probe can measure while this session is live.

import { CdpClient } from '@chromatrix/cdp'

export interface ConsumerResult {
  targetId: string
  sessionId: string
  runtimeContextId: number | undefined
  gotExecutionContext: boolean
  evaluateOk: boolean
  evaluateValue: unknown
  error?: string
}

export async function runConsumer(muxUrl: string): Promise<{ result: ConsumerResult; close: () => void }> {
  const client = await CdpClient.connect(muxUrl)
  const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await client.send('Page.enable', {}, sessionId)

  let runtimeContextId: number | undefined
  let gotExecutionContext = false
  let evaluateOk = false
  let evaluateValue: unknown
  let error: string | undefined

  try {
    // Register the wait BEFORE enabling Runtime, so we don't miss the event.
    const ctxPromise = client.once('Runtime.executionContextCreated', { sessionId, timeoutMs: 5000 })
    await client.send('Runtime.enable', {}, sessionId)
    const ctxEvent = await ctxPromise
    runtimeContextId = (ctxEvent.context as { id: number }).id
    gotExecutionContext = true

    const res = await client.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: '1 + 1', contextId: runtimeContextId, returnByValue: true },
      sessionId,
    )
    evaluateValue = res.result?.value
    evaluateOk = evaluateValue === 2
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return {
    result: { targetId, sessionId, runtimeContextId, gotExecutionContext, evaluateOk, evaluateValue, error },
    close: () => client.close(),
  }
}
