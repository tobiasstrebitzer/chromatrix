// Automated S4 gate — verifies the takeover MECHANISM without a human:
//   1. screencast frames actually flow, and
//   2. injected mouse + keyboard input produce isTrusted events and drive the page.
// Runs headless (fast, no window). The real "log in by hand" flow uses the same primitives via server.ts.

import { launchChrome } from './launch-chrome.ts'
import { CdpClient } from './cdp-client.ts'
import { startScreencast, dispatchMouse, dispatchKey } from './screencast.ts'

// A self-contained page: a button that records isTrusted on click, a text input, and a rAF loop that keeps
// repainting (so the screencast has frames to send even without navigation).
const PAGE = `data:text/html,` +
  encodeURIComponent(`<!doctype html><html><body style="margin:0;font:16px sans-serif">
    <button id="b" style="position:absolute;left:80px;top:80px;width:160px;height:48px">click me</button>
    <input id="t" style="position:absolute;left:80px;top:160px;width:240px;height:32px" />
    <div id="tick" style="position:absolute;left:80px;top:220px"></div>
    <script>
      window.__click = null;
      document.getElementById('b').addEventListener('click', function(e){ window.__click = { trusted: e.isTrusted }; });
      var n = 0; (function loop(){ n++; document.getElementById('tick').textContent = 'f'+n; requestAnimationFrame(loop); })();
    </script>
  </body></html>`)

async function evaluate<T>(c: CdpClient, sid: string, expression: string): Promise<T> {
  const r = await c.send<{ result?: { value?: T } }>('Runtime.evaluate', { expression, returnByValue: true }, sid)
  return r.result?.value as T
}

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: true, startUrl: PAGE })
  const client = await CdpClient.connect(chrome.browserWsUrl)
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  try {
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: PAGE })
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    await new Promise((r) => setTimeout(r, 500))

    // 1) Screencast frames flow.
    let frames = 0
    const stop = await startScreencast(client, sessionId, () => {
      frames++
    })
    await new Promise((r) => setTimeout(r, 1500))
    await stop()
    checks.push({ name: 'screencast frames flow', ok: frames > 0, detail: `${frames} frames in 1.5s` })

    // 2) Injected mouse click is isTrusted and fires the handler.
    const rect = await evaluate<{ x: number; y: number }>(
      client,
      sessionId,
      `(function(){var r=document.getElementById('b').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
    )
    await dispatchMouse(client, sessionId, { type: 'mouseMoved', x: rect.x, y: rect.y })
    await dispatchMouse(client, sessionId, { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1 })
    await dispatchMouse(client, sessionId, { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 1 })
    await new Promise((r) => setTimeout(r, 150))
    const click = await evaluate<{ trusted: boolean } | null>(client, sessionId, 'window.__click')
    checks.push({ name: 'mouse click fires handler', ok: !!click, detail: click ? 'handler ran' : 'no click' })
    checks.push({ name: 'click event isTrusted', ok: click?.trusted === true, detail: `isTrusted=${click?.trusted}` })

    // 3) Injected keyboard types into the focused input.
    await dispatchMouse(client, sessionId, { type: 'mousePressed', x: 120, y: 176, button: 'left', buttons: 1 })
    await dispatchMouse(client, sessionId, { type: 'mouseReleased', x: 120, y: 176, button: 'left', buttons: 1 })
    await evaluate(client, sessionId, `document.getElementById('t').focus()`)
    for (const ch of 'hi-42') {
      await dispatchKey(client, sessionId, { type: 'keyDown', key: ch })
      await dispatchKey(client, sessionId, { type: 'keyUp', key: ch })
    }
    await new Promise((r) => setTimeout(r, 100))
    const typed = await evaluate<string>(client, sessionId, `document.getElementById('t').value`)
    checks.push({ name: 'keyboard types into input', ok: typed === 'hi-42', detail: `value="${typed}"` })

    await client.send('Target.closeTarget', { targetId }).catch(() => {})
  } finally {
    client.close()
    chrome.close()
  }

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(' chromatrix · S4 self-test — screencast + isTrusted input')
  console.log('══════════════════════════════════════════════════════════════════\n')
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name.padEnd(30)} ${c.detail}`)
  const allOk = checks.every((c) => c.ok)
  console.log(`\n  ${allOk ? '✅ S4 mechanism PROVEN' : '❌ S4 self-test FAILED'} — the takeover primitives ${allOk ? 'work' : 'need fixing'}.`)
  console.log('  Real manual-login flow: `pnpm s4` opens the interactive viewer.\n')
  if (!allOk) process.exitCode = 1
}

main().catch((e) => {
  console.error('S4 self-test failed:', e)
  process.exitCode = 1
})
