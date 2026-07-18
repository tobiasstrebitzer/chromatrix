// Diagnostic: find what actually triggers the Runtime.enable console-preview getter leak on THIS Chrome.
// Tests several trap shapes, both same-session (Runtime enabled on the evaluating session) and via a
// separate enabled session, so we can tell "technique dead on Chrome 150" apart from "harness bug".

import { launchChrome } from '@chromatrix/stealth'
import { CdpClient } from '@chromatrix/cdp'

const TRAPS: Record<string, string> = {
  'plain-obj-enumerable-id': `
    window.__hit = false;
    var t = {}; Object.defineProperty(t, 'id', { enumerable: true, get: function(){ window.__hit = true; return 1; } });
    console.debug('probe', t); 'armed'`,
  'plain-obj-nonenum-id': `
    window.__hit = false;
    var t = {}; Object.defineProperty(t, 'id', { enumerable: false, get: function(){ window.__hit = true; return 1; } });
    console.debug('probe', t); 'armed'`,
  'div-id-getter': `
    window.__hit = false;
    var d = document.createElement('div');
    Object.defineProperty(d, 'id', { get: function(){ window.__hit = true; return 'x'; } });
    console.log(d); 'armed'`,
  'error-stack-getter': `
    window.__hit = false;
    var e = new Error('x');
    Object.defineProperty(e, 'stack', { get: function(){ window.__hit = true; return ''; } });
    console.log(e); 'armed'`,
  'console-log-plain': `
    window.__hit = false;
    var t = {}; Object.defineProperty(t, 'id', { enumerable: true, get: function(){ window.__hit = true; return 1; } });
    console.log(t); 'armed'`,
}

async function evalOn(c: CdpClient, sessionId: string, expression: string): Promise<unknown> {
  const r = await c.send<{ result?: { value?: unknown } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId,
  )
  return r.result?.value
}

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: true })
  try {
    for (const [name, trap] of Object.entries(TRAPS)) {
      // Fresh target per trap.
      const browser = await CdpClient.connect(chrome.browserWsUrl)
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })

      // "enabled" session: attaches and enables Runtime (the CDP presence we want to detect).
      const enabled = await CdpClient.connect(chrome.browserWsUrl)
      const { sessionId: enSid } = await enabled.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      await enabled.send('Runtime.enable', {}, enSid)

      // "observer" session: never enables Runtime; arms trap in main world and reads the flag.
      const observer = await CdpClient.connect(chrome.browserWsUrl)
      const { sessionId: obSid } = await observer.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      })
      await evalOn(observer, obSid, trap)
      await new Promise((r) => setTimeout(r, 400))
      const viaSeparate = await evalOn(observer, obSid, 'window.__hit === true')

      // same-session variant: the enabled session itself arms + reads.
      await evalOn(enabled, enSid, trap)
      await new Promise((r) => setTimeout(r, 400))
      const viaSame = await evalOn(enabled, enSid, 'window.__hit === true')

      console.log(
        `${name.padEnd(28)}  separate-enabled-session: ${String(viaSeparate).padEnd(6)}  same-session: ${String(viaSame)}`,
      )

      browser.close()
      enabled.close()
      observer.close()
      await new Promise((r) => setTimeout(r, 50))
      const closer = await CdpClient.connect(chrome.browserWsUrl)
      await closer.send('Target.closeTarget', { targetId }).catch(() => {})
      closer.close()
    }
  } finally {
    chrome.close()
  }
}

main().catch((e) => {
  console.error('diag failed:', e)
  process.exitCode = 1
})
