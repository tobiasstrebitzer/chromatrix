// Confirm whether Chrome still generates a property preview for console args (which is what invoked
// getters — the leak). Enable Runtime, subscribe to consoleAPICalled, console.log a getter object, and
// dump the exact event payload.

import { launchChrome } from '@chromatrix/fidelity'
import { CdpClient } from '@chromatrix/cdp'

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: true })
  try {
    const c = await CdpClient.connect(chrome.browserWsUrl)
    const { targetId } = await c.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await c.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })

    const events: unknown[] = []
    c.on('Runtime.consoleAPICalled', (params) => events.push(params))

    await c.send('Runtime.enable', {}, sessionId)
    await c.send(
      'Runtime.evaluate',
      {
        expression: `
          window.__hit = false;
          var t = { plain: 'v' };
          Object.defineProperty(t, 'id', { enumerable: true, get: function(){ window.__hit = true; return 42; } });
          console.log('LEAKTEST', t);
          'ok'`,
      },
      sessionId,
    )
    await new Promise((r) => setTimeout(r, 500))
    const hit = await c.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'window.__hit === true', returnByValue: true },
      sessionId,
    )

    console.log('getter fired:', hit.result?.value)
    console.log('consoleAPICalled events:', events.length)
    console.log(JSON.stringify(events, null, 2))

    c.close()
  } finally {
    chrome.close()
  }
}

main().catch((e) => {
  console.error('diag2 failed:', e)
  process.exitCode = 1
})
