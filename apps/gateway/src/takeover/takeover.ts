// Takeover — the human-in-the-loop path (PRD §4/§0, promoted from spike S4). A per-identity hub attaches to
// the identity's front page target over the control CDP client, runs ONE ack-throttled JPEG screencast, and
// fans frames out to every connected viewer while forwarding their mouse/keyboard back as Input.dispatch*
// events (which are isTrusted — indistinguishable from a real user). This is how a person completes a
// one-time login or clears an interactive human-verification gate; the persistent profile keeps the session
// afterwards. No JS is injected into the page, and neither CDP method is on the agent-scoped mux path.

import type { CdpClient } from '@chromatrix/cdp'
import type { WebSocket } from 'ws'

interface FrameMetadata {
  deviceWidth: number
  deviceHeight: number
}

const NON_PRINTABLE: Record<string, { keyCode: number; text?: string }> = {
  Enter: { keyCode: 13, text: '\r' },
  Tab: { keyCode: 9 },
  Backspace: { keyCode: 8 },
  Delete: { keyCode: 46 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  ArrowUp: { keyCode: 38 },
  ArrowDown: { keyCode: 40 },
  Escape: { keyCode: 27 },
}

/** One takeover session per identity. Lazily attaches + screencasts on the first viewer; stops on the last. */
export class TakeoverHub {
  private readonly viewers = new Set<WebSocket>()
  private sessionId?: string
  private casting = false
  private lastMeta: FrameMetadata = { deviceWidth: 1, deviceHeight: 1 }

  constructor(private readonly client: CdpClient) {}

  async addViewer(ws: WebSocket): Promise<void> {
    this.viewers.add(ws)
    await this.ensureCasting()

    ws.on('message', (raw) => {
      let m: {
        type?: string
        event?: string
        phase?: string
        nx?: number
        ny?: number
        dx?: number
        dy?: number
        button?: string
        buttons?: number
        key?: string
        code?: string
        keyCode?: number
      }
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      void this.onInput(m)
    })

    ws.on('close', () => {
      this.viewers.delete(ws)
      if (this.viewers.size === 0) void this.stopCasting()
    })
  }

  private async ensureCasting(): Promise<void> {
    if (this.casting) return
    this.casting = true
    const sid = await this.attachFrontPage()
    this.sessionId = sid
    this.client.on('Page.screencastFrame', (params, evSid) => {
      if (evSid !== sid) return
      const p = params as { data: string; sessionId: number; metadata: FrameMetadata }
      void this.client.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {})
      this.lastMeta = p.metadata
      const msg = JSON.stringify({ type: 'frame', data: p.data, dw: p.metadata.deviceWidth, dh: p.metadata.deviceHeight })
      for (const v of this.viewers) if (v.readyState === v.OPEN) v.send(msg)
    })
    await this.client.send(
      'Page.startScreencast',
      { format: 'jpeg', quality: 75, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 },
      sid,
    )
  }

  private async stopCasting(): Promise<void> {
    if (!this.casting || !this.sessionId) return
    await this.client.send('Page.stopScreencast', {}, this.sessionId).catch(() => {})
    this.casting = false
    this.sessionId = undefined
  }

  private async attachFrontPage(): Promise<string> {
    const { targetInfos } = await this.client.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
      'Target.getTargets',
    )
    const page = targetInfos.find((t) => t.type === 'page')
    if (!page) throw new Error('takeover: no page target to attach to')
    const { sessionId } = await this.client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    await this.client.send('Page.enable', {}, sessionId)
    return sessionId
  }

  private async onInput(m: {
    type?: string
    event?: string
    phase?: string
    nx?: number
    ny?: number
    dx?: number
    dy?: number
    button?: string
    buttons?: number
    key?: string
    code?: string
    keyCode?: number
  }): Promise<void> {
    const sid = this.sessionId
    if (!sid) return
    const dw = this.lastMeta.deviceWidth
    const dh = this.lastMeta.deviceHeight
    if (m.type === 'mouse') {
      const type = m.event === 'down' ? 'mousePressed' : m.event === 'up' ? 'mouseReleased' : 'mouseMoved'
      await this.client
        .send(
          'Input.dispatchMouseEvent',
          {
            type,
            x: (m.nx ?? 0) * dw,
            y: (m.ny ?? 0) * dh,
            button: m.button ?? 'none',
            buttons: m.buttons ?? 0,
            clickCount: type === 'mouseMoved' ? 0 : 1,
          },
          sid,
        )
        .catch(() => {})
    } else if (m.type === 'wheel') {
      await this.client
        .send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: (m.nx ?? 0) * dw, y: (m.ny ?? 0) * dh, deltaX: m.dx, deltaY: m.dy }, sid)
        .catch(() => {})
    } else if (m.type === 'key' && m.key) {
      const printable = m.key.length === 1
      const special = NON_PRINTABLE[m.key]
      const text = printable ? m.key : special?.text
      const down = m.phase === 'down'
      await this.client
        .send(
          'Input.dispatchKeyEvent',
          {
            type: down ? 'keyDown' : 'keyUp',
            key: m.key,
            code: m.code ?? (printable ? `Key${m.key.toUpperCase()}` : m.key),
            windowsVirtualKeyCode: m.keyCode ?? special?.keyCode ?? (printable ? m.key.toUpperCase().charCodeAt(0) : 0),
            ...(text && down ? { text } : {}),
          },
          sid,
        )
        .catch(() => {})
    }
  }
}

/** The minimal viewer page served at GET /takeover/<id>; drives the real tab via /takeover/<id>/ws. */
export function takeoverViewerHtml(identity: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>chromatrix · takeover · ${identity}</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #0b0d10; color: #cdd3da; font: 13px ui-monospace, monospace; overflow: hidden; }
      #bar { height: 34px; display: flex; align-items: center; gap: 14px; padding: 0 12px; background: #14171c; border-bottom: 1px solid #222; }
      #bar b { color: #6ee7b7; }
      #dot { width: 9px; height: 9px; border-radius: 50%; background: #f87171; }
      #dot.live { background: #34d399; }
      #wrap { position: absolute; top: 34px; bottom: 0; left: 0; right: 0; display: grid; place-items: center; }
      #screen { max-width: 100%; max-height: 100%; cursor: crosshair; image-rendering: auto; background: #000; box-shadow: 0 0 0 1px #222; }
      #hint { color: #7c8794; }
    </style>
  </head>
  <body>
    <div id="bar">
      <span id="dot"></span><b>chromatrix</b> takeover · <span style="color:#93c5fd">${identity}</span>
      <span id="status">connecting…</span>
      <span id="hint">— click / type directly on the frame; your input drives the real tab</span>
    </div>
    <div id="wrap"><img id="screen" draggable="false" /></div>
    <script>
      const img = document.getElementById('screen')
      const status = document.getElementById('status')
      const dot = document.getElementById('dot')
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/takeover/${identity}/ws')
      let frames = 0
      ws.onopen = () => { status.textContent = 'connected' }
      ws.onclose = () => { status.textContent = 'disconnected'; dot.classList.remove('live') }
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'frame') {
          img.src = 'data:image/jpeg;base64,' + m.data
          if (++frames % 10 === 0) status.textContent = frames + ' frames'
          dot.classList.add('live')
        }
      }
      function norm(e) {
        const r = img.getBoundingClientRect()
        return { nx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), ny: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
      }
      const BTN = ['left', 'middle', 'right']
      function send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }
      img.addEventListener('mousemove', (e) => { const n = norm(e); send({ type: 'mouse', event: 'move', nx: n.nx, ny: n.ny, buttons: e.buttons }) })
      img.addEventListener('mousedown', (e) => { e.preventDefault(); const n = norm(e); send({ type: 'mouse', event: 'down', nx: n.nx, ny: n.ny, button: BTN[e.button] || 'left', buttons: e.buttons }) })
      img.addEventListener('mouseup', (e) => { e.preventDefault(); const n = norm(e); send({ type: 'mouse', event: 'up', nx: n.nx, ny: n.ny, button: BTN[e.button] || 'left', buttons: e.buttons }) })
      img.addEventListener('contextmenu', (e) => e.preventDefault())
      img.addEventListener('wheel', (e) => { e.preventDefault(); const n = norm(e); send({ type: 'wheel', nx: n.nx, ny: n.ny, dx: e.deltaX, dy: e.deltaY }) }, { passive: false })
      window.addEventListener('keydown', (e) => { e.preventDefault(); send({ type: 'key', phase: 'down', key: e.key, code: e.code, keyCode: e.keyCode }) })
      window.addEventListener('keyup', (e) => { e.preventDefault(); send({ type: 'key', phase: 'up', key: e.key, code: e.code, keyCode: e.keyCode }) })
    </script>
  </body>
</html>`
}
