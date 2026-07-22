// Takeover input e2e - drag-selection, click counts, modifiers, and the clipboard round trip.
//
//   pnpm --filter @chromatrix/gateway run takeover            # headless (default)
//   HEADLESS=0 pnpm --filter @chromatrix/gateway run takeover # watch it happen
//
// These are the parts of takeover a human normally has to verify by hand, which in practice means they were
// never verified at all: you cannot see from a screencast whether a selection drag actually dragged, and the
// clipboard path has no visible failure mode short of "nothing was copied". Everything here is asserted from
// the page's own state, read back over a second CDP connection.
//
// What each case is really pinning down:
//   • clickCount   - a triple-click selects a line only if the count survives the wire (it was hardcoded to 1)
//   • drag         - a mouseMoved with the button named extends a selection; with button 'none' it does nothing
//   • modifiers    - Meta must reach the page, AND must suppress `text` so Cmd+C doesn't type a "c"
//   • clipboard    - copy/cut are answered by the hub reading the page's selection, not by key events

import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { CdpClient } from '@chromatrix/cdp'

const HEADLESS = process.env.HEADLESS !== '0'
const VIEWPORT = { width: 800, height: 600 }
/** The line the selection cases operate on. Monospace, so its on-screen extent is predictable. */
const LINE = 'SELECTABLE_TEXT_LINE'
const PASTED = 'pasted-via-takeover'

// Laid out in absolute CSS pixels so the test can aim at it: the line occupies y 0..60, the input y 200..240.
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>takeover-input</title></head>
<body style="margin:0;background:#fff">
<div id="line" style="font:40px/60px monospace;white-space:nowrap">${LINE}</div>
<input id="box" style="position:absolute;top:200px;left:0;width:600px;height:40px;font:24px monospace">
</body></html>`

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` - ${detail}` : ''}`)
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function startPageServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() })
    })
  })
}

/** The takeover socket, wrapped so a test can await the one reply it just asked for. */
class Viewer {
  private readonly waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void; timer: NodeJS.Timeout }> = []
  meta = { dw: 0, dh: 0 }

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      let m: any
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.type === 'frame') this.meta = { dw: m.dw, dh: m.dh }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(m)) {
          clearTimeout(this.waiters[i].timer)
          this.waiters.splice(i, 1)[0].resolve(m)
        }
      }
    })
  }

  static async open(url: string): Promise<Viewer> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return new Viewer(ws)
  }

  send(o: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  await(match: (m: any) => boolean, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for a takeover message`)), timeoutMs)
      this.waiters.push({ match, resolve, timer })
    })
  }

  /** CSS pixel → the normalized coordinate the wire protocol carries. */
  at(x: number, y: number): { nx: number; ny: number } {
    return { nx: x / this.meta.dw, ny: y / this.meta.dh }
  }

  close(): void {
    this.ws.close()
  }
}

const META = 4 // CDP modifier bitmask: Meta/Command

async function main(): Promise<void> {
  const profiles = mkdtempSync(join(tmpdir(), 'chromatrix-takeover-'))
  process.env.CHROMATRIX_PROFILES = profiles
  const { startGateway } = await import('../bootstrap.ts')
  const page = await startPageServer()
  const accessToken = 'test-access-token-takeover'
  const handle = await startGateway({ port: 0, accessToken })
  const base = `http://${handle.host}:${handle.port}/api`
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    return res.json()
  }

  console.log(`\nchromatrix · takeover input e2e`)
  console.log(`  ${HEADLESS ? 'headless' : 'headed'} · viewport ${VIEWPORT.width}×${VIEWPORT.height}`)
  console.log(`  profiles: ${profiles}\n`)

  const identity = 'tko'
  let viewer: Viewer | undefined
  let tab: CdpClient | undefined
  try {
    await post('/identity', { id: identity })
    await post('/identity/start', { id: identity, headless: HEADLESS })
    const lease = (await post('/tab/allocate', {
      identity,
      agentId: 'tko-agent',
      url: page.url,
      ...VIEWPORT,
    })) as { targetId: string; cdpUrl: string }

    // A second, ordinary CDP connection to the same tab - this is how every assertion below reads the page's
    // real state, rather than trusting the takeover path to report on itself.
    tab = await CdpClient.connect(lease.cdpUrl)
    const { sessionId } = await tab.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: lease.targetId,
      flatten: true,
    })
    const evaluate = async (expression: string): Promise<string> => {
      const res = await tab!.send<{ result?: { value?: string } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        sessionId,
      )
      return res.result?.value ?? ''
    }
    // Wait for the page itself, not just the navigation command.
    for (let i = 0; i < 40 && (await evaluate('document.readyState')) !== 'complete'; i++) await delay(100)

    const wsUrl = `ws://${handle.host}:${handle.port}/takeover/${identity}/ws?token=${accessToken}`
    viewer = await Viewer.open(wsUrl)
    // Coordinates are normalized against the frame, so nothing can be aimed until a frame has arrived and
    // reported the page's real device size.
    await viewer.await((m) => m.type === 'frame', 20_000)
    check('screencast delivered a frame with device metrics', viewer.meta.dw > 0 && viewer.meta.dh > 0, `${viewer.meta.dw}×${viewer.meta.dh}`)

    const mouse = (event: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
      const n = viewer!.at(x, y)
      viewer!.send({ type: 'mouse', event, nx: n.nx, ny: n.ny, ...extra })
    }
    const copy = async (action: 'copy' | 'cut' = 'copy'): Promise<string> => {
      viewer!.send({ type: 'clipboard', action })
      const m = await viewer!.await((x) => x.type === 'clipboard')
      return m.text ?? ''
    }
    const clearSelection = () => evaluate('window.getSelection().removeAllRanges(), document.activeElement.blur(), "ok"')

    // 1. Triple-click selects the line. Proves clickCount reaches Chrome: with it pinned to 1 this selects
    //    nothing but a caret position, and the copy comes back empty.
    mouse('down', 100, 30, { button: 'left', buttons: 1, clickCount: 3 })
    mouse('up', 100, 30, { button: 'left', buttons: 0, clickCount: 3 })
    await delay(150)
    const tripled = await copy()
    check('triple-click selects the line (clickCount)', tripled.trim() === LINE, `"${tripled.trim()}"`)

    // 2. Drag selects a range. The moves deliberately DO NOT name a button, only the held-buttons mask - that
    //    is what a viewer reporting raw DOM state sends, and it is exactly the case that used to fail: the hub
    //    defaulted `button` to 'none', Chrome read the move as a hover, and the selection never grew. Verified
    //    against the real dashboard: with the old code this same gesture selected nothing at all. Keep the
    //    button out of these messages or this check stops testing heldButton() and starts testing nothing.
    await clearSelection()
    mouse('down', 4, 30, { button: 'left', buttons: 1, clickCount: 1 })
    for (const x of [80, 160, 240, 300]) mouse('move', x, 30, { buttons: 1 })
    mouse('up', 300, 30, { button: 'left', buttons: 0, clickCount: 1 })
    await delay(200)
    const dragged = await copy()
    const draggedOk = dragged.length > 0 && LINE.startsWith(dragged.trim()) && dragged.trim() !== LINE
    check('dragging selects a partial range', draggedOk, `"${dragged.trim()}" (${dragged.trim().length}/${LINE.length} chars)`)

    // 3. Select-all as an editing command on the key event - the only way it works, since a synthesized
    //    Cmd+A never reaches the browser layer that would otherwise handle it.
    await clearSelection()
    viewer.send({ type: 'key', phase: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: META, action: 'selectAll' })
    viewer.send({ type: 'key', phase: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: META })
    await delay(200)
    const all = await copy()
    check('Cmd+A selects the document (selectAll command)', all.includes(LINE), `${all.trim().length} chars`)

    // 4. Paste inserts into the focused field.
    mouse('down', 100, 220, { button: 'left', buttons: 1, clickCount: 1 })
    mouse('up', 100, 220, { button: 'left', buttons: 0, clickCount: 1 })
    await delay(150)
    viewer.send({ type: 'paste', text: PASTED })
    await delay(250)
    check('paste inserts text into the focused input', (await evaluate('document.getElementById("box").value')) === PASTED, await evaluate('document.getElementById("box").value'))

    // 5. A modified key must not ALSO type its character. This is the bug where Cmd+C put a literal "c" in
    //    the field before anything else happened - invisible in a screencast, corrupting in a login form.
    viewer.send({ type: 'key', phase: 'down', key: 'c', code: 'KeyC', keyCode: 67, modifiers: META })
    viewer.send({ type: 'key', phase: 'up', key: 'c', code: 'KeyC', keyCode: 67, modifiers: META })
    await delay(250)
    const afterCmdC = await evaluate('document.getElementById("box").value')
    check('Cmd+<key> does not type its character', afterCmdC === PASTED, `"${afterCmdC}"`)

    // 6. Copy reads a selection inside an input, which window.getSelection() cannot see - then cut removes it.
    await evaluate('document.getElementById("box").focus(), document.getElementById("box").select(), "ok"')
    const fromField = await copy()
    check('copy reads a selection inside an <input>', fromField === PASTED, `"${fromField}"`)

    const cutText = await copy('cut')
    await delay(200)
    const afterCut = await evaluate('document.getElementById("box").value')
    check('cut returns the text and clears the field', cutText === PASTED && afterCut === '', `cut "${cutText}", field now "${afterCut}"`)
  } finally {
    viewer?.close()
    tab?.close()
    page.close()
    await handle.close().catch(() => {})
    rmSync(profiles, { recursive: true, force: true })
  }

  const passed = results.every((r) => r.ok)
  console.log(`\n${passed ? 'PASS' : 'FAIL'} - ${results.filter((r) => r.ok).length}/${results.length} checks\n`)
  process.exitCode = passed ? 0 : 1
}

main().catch((e) => {
  console.error('\ntakeover input e2e errored:', e)
  process.exitCode = 1
})
