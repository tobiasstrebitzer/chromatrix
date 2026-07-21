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

/** A tab the human can pick in the viewer (mirrors the gateway's TargetView). */
export interface TargetSummary {
  targetId: string
  url: string
  title: string
  agentId?: string
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
  private lastMeta: FrameMetadata = { deviceWidth: 1, deviceHeight: 1 }
  /**
   * The most recent frame, verbatim, replayed to every joining viewer. Load-bearing: `Page.screencastFrame`
   * only fires on a *repaint*, so a page that is sitting still (a login form waiting for a human — i.e. the
   * exact thing takeover exists for) emits one frame when the cast starts and then nothing. Without this
   * replay a viewer that joins after that first frame renders an empty <img> forever.
   */
  private lastFrame?: string
  private onFrame?: (params: unknown, sessionId?: string) => void
  private watching = false
  /** Serializes start/stop so a disconnect+reconnect can't interleave into a live-but-frameless cast. */
  private chain: Promise<unknown> = Promise.resolve()
  /** The tab the human picked. Sticky across re-attaches; cleared when that tab goes away. */
  private wantedTargetId?: string
  /** The tab currently being cast, so viewers can highlight it in the picker. */
  private activeTargetId?: string

  constructor(
    private readonly client: CdpClient,
    /** Lists the identity's viewable page targets — the source for the viewer's tab picker. */
    private readonly listTargets: () => Promise<TargetSummary[]>,
  ) {}

  async addViewer(ws: WebSocket): Promise<void> {
    this.viewers.add(ws)
    // If there is nothing to cast, startCasting broadcasts the waiting state — and this viewer is already in
    // the set, so it receives it. No per-viewer send here or a joiner would get the message twice.
    await this.serialize(() => this.startCasting())
    if (this.sessionId && this.lastFrame && ws.readyState === ws.OPEN) {
      // Late joiner: paint it immediately from cache rather than waiting for a repaint that may never come.
      ws.send(this.lastFrame)
    }
    void this.pushTargets(ws)

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
        targetId?: string
      }
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.type === 'attach' && m.targetId) {
        void this.attachTo(m.targetId)
        return
      }
      void this.onInput(m)
    })

    const drop = () => {
      this.viewers.delete(ws)
      if (this.viewers.size === 0) {
        void this.serialize(async () => {
          await this.stopCasting()
          this.unwatchPages()
        })
      }
    }
    ws.on('close', drop)
    // A viewer socket error must not crash the gateway (`ws` rethrows an unhandled 'error'); drop the viewer.
    ws.on('error', drop)
  }

  /**
   * Run casting state transitions one at a time. The dashboard unmounts and remounts the viewer on every
   * client-side navigation (and twice on mount under React StrictMode), so close→open arrive back-to-back:
   * unserialized, the new viewer's start would no-op against the still-`true` casting flag and then the old
   * viewer's stop would tear down the cast underneath it — connected, live, and permanently blank.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  /** True if this hub is still bound to the identity's current control channel (false after a stop/start). */
  usesClient(client: CdpClient): boolean {
    return this.client === client
  }

  /** Drop CDP listeners so a hub replaced after a restart doesn't leak into the old, dead client. */
  dispose(): void {
    this.unwatchPages()
    if (this.onFrame) {
      this.client.off('Page.screencastFrame', this.onFrame)
      this.onFrame = undefined
    }
    for (const v of this.viewers) if (v.readyState === v.OPEN) v.close()
    this.viewers.clear()
    this.sessionId = undefined
    this.lastFrame = undefined
  }

  /** Switch the cast to a specific tab (the viewer's picker). Sticky: re-attaches keep this choice. */
  private async attachTo(targetId: string): Promise<void> {
    if (targetId === this.activeTargetId) return
    this.wantedTargetId = targetId
    await this.serialize(async () => {
      await this.stopCasting()
      await this.startCasting()
    })
    await this.pushTargets()
  }

  private broadcast(msg: unknown): void {
    const s = JSON.stringify(msg)
    for (const v of this.viewers) if (v.readyState === v.OPEN) v.send(s)
  }

  /** Send the current tab list + which one is live, so every viewer's picker stays in sync. */
  private async pushTargets(only?: WebSocket): Promise<void> {
    let targets: TargetSummary[] = []
    try {
      targets = await this.listTargets()
    } catch {
      return // the identity may have stopped mid-flight; the next change event will resync
    }
    const msg = JSON.stringify({ type: 'targets', targets, activeTargetId: this.activeTargetId })
    const to = only ? [only] : [...this.viewers]
    for (const v of to) if (v.readyState === v.OPEN) v.send(msg)
  }

  private async startCasting(): Promise<void> {
    if (this.sessionId) return
    await this.watchForPages()
    const sid = await this.attachFrontPage()
    if (!sid) {
      // No tab to cast — either none yet, or the LAST one was just closed/released. Every viewer must hear
      // this, not only joiners: without it, closing the final tab leaves the previous frame frozen on screen,
      // which reads as a live page. The target watcher calls back here when a tab opens.
      this.broadcast({ type: 'waiting', message: 'No open tab to view yet — allocate one to take over.' })
      return
    }
    const onFrame = (params: unknown, evSid?: string) => {
      if (evSid !== sid) return
      const p = params as { data: string; sessionId: number; metadata: FrameMetadata }
      void this.client.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {})
      this.lastMeta = p.metadata
      const msg = JSON.stringify({ type: 'frame', data: p.data, dw: p.metadata.deviceWidth, dh: p.metadata.deviceHeight })
      this.lastFrame = msg
      for (const v of this.viewers) if (v.readyState === v.OPEN) v.send(msg)
    }
    this.onFrame = onFrame
    this.client.on('Page.screencastFrame', onFrame)
    this.sessionId = sid
    await this.client.send(
      'Page.startScreencast',
      { format: 'jpeg', quality: 75, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 },
      sid,
    )
  }

  private async stopCasting(): Promise<void> {
    const sid = this.sessionId
    if (!sid) return
    this.sessionId = undefined
    this.lastFrame = undefined // a stale frame must not be replayed into the next, possibly different, cast
    if (this.onFrame) {
      this.client.off('Page.screencastFrame', this.onFrame) // else every start/stop cycle leaks a listener
      this.onFrame = undefined
    }
    await this.client.send('Page.stopScreencast', {}, sid).catch(() => {})
    await this.client.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {})
  }

  /**
   * Watch for tabs opening so a viewer attached to an identity with no tabs starts casting the moment one
   * appears, and so a cast whose tab was closed/released re-attaches to whatever is left.
   */
  private async watchForPages(): Promise<void> {
    if (this.watching) return
    this.watching = true
    await this.client.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
    this.client.on('Target.targetCreated', this.onTargetChange)
    this.client.on('Target.targetDestroyed', this.onTargetChange)
  }

  private unwatchPages(): void {
    if (!this.watching) return
    this.watching = false
    this.client.off('Target.targetCreated', this.onTargetChange)
    this.client.off('Target.targetDestroyed', this.onTargetChange)
  }

  private readonly onTargetChange = (): void => {
    if (this.viewers.size === 0) return
    void this.serialize(async () => {
      // A destroyed tab leaves a dead session behind; drop it so we re-pick a live one.
      if (this.sessionId && !(await this.sessionIsLive())) await this.stopCasting()
      if (!this.sessionId) await this.startCasting()
    }).then(() => this.pushTargets())
  }

  private async sessionIsLive(): Promise<boolean> {
    if (!this.sessionId) return false
    return await this.client
      .send('Runtime.evaluate', { expression: '1', returnByValue: true }, this.sessionId)
      .then(() => true)
      .catch(() => false)
  }

  private async attachFrontPage(): Promise<string | undefined> {
    const { targetInfos } = await this.client.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }>('Target.getTargets')
    const pages = targetInfos.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    // The human's pick wins whenever that tab still exists. Otherwise prefer a tab that has actually
    // navigated somewhere: getTargets order is not specified, so picking the first page can land on a blank
    // one and show an empty screen while the real tab is right there.
    const page =
      (this.wantedTargetId ? pages.find((t) => t.targetId === this.wantedTargetId) : undefined) ??
      pages.find((t) => t.url !== '' && t.url !== 'about:blank') ??
      pages[0]
    if (!page) {
      this.activeTargetId = undefined
      return undefined
    }
    // Foreground the tab: a backgrounded page is not composited, so it never repaints and never emits frames.
    await this.client.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {})
    const { sessionId } = await this.client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    })
    await this.client.send('Page.enable', {}, sessionId)
    this.activeTargetId = page.targetId
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
