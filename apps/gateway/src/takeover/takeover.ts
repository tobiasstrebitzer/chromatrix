// Takeover - the human-in-the-loop path (promoted from spike S4; docs/FINDINGS.md). A per-identity hub attaches to
// the identity's front page target over the control CDP client, runs ONE ack-throttled JPEG screencast, and
// fans frames out to every connected viewer while forwarding their mouse/keyboard back as Input.dispatch*
// events (which are isTrusted - indistinguishable from a real user). This is how a person completes a
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

/** Everything a viewer can send. One shape, because it arrives as one untyped JSON frame off the socket. */
interface ViewerMessage {
  type?: string
  event?: string
  phase?: string
  nx?: number
  ny?: number
  dx?: number
  dy?: number
  button?: string
  buttons?: number
  clickCount?: number
  /** CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Command=4, Shift=8. */
  modifiers?: number
  key?: string
  code?: string
  keyCode?: number
  text?: string
  action?: string
  targetId?: string
}

/** Coalescing window for `Target.targetInfoChanged`, which fires several times per navigation. */
const TARGET_INFO_DEBOUNCE_MS = 300

/** Which mouse button a move is dragging, read off the held-buttons bitmask. */
function heldButton(buttons: number): string {
  if (buttons & 1) return 'left'
  if (buttons & 2) return 'right'
  if (buttons & 4) return 'middle'
  return 'none'
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
  Home: { keyCode: 36 },
  End: { keyCode: 35 },
  PageUp: { keyCode: 33 },
  PageDown: { keyCode: 34 },
}

/**
 * Read the current selection out of the page.
 *
 * Two cases, because they are genuinely different in the DOM: a selection inside an `<input>`/`<textarea>`
 * lives on the element (`selectionStart/End`) and is invisible to `window.getSelection()`, which is what an
 * ordinary document selection uses. Checking the focused element first is what makes "copy the OTP I just
 * highlighted in a form field" work at all. A selection inside a cross-origin iframe is not reachable from
 * here and comes back empty.
 */
const READ_SELECTION_JS = `(() => {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') {
    return String(el.value).slice(el.selectionStart, el.selectionEnd)
  }
  const s = window.getSelection()
  return s ? s.toString() : ''
})()`

/** One takeover session per identity. Lazily attaches + screencasts on the first viewer; stops on the last. */
export class TakeoverHub {
  private readonly viewers = new Set<WebSocket>()
  private sessionId?: string
  private lastMeta: FrameMetadata = { deviceWidth: 1, deviceHeight: 1 }
  /**
   * The most recent frame, verbatim, replayed to every joining viewer. Load-bearing: `Page.screencastFrame`
   * only fires on a *repaint*, so a page that is sitting still (a login form waiting for a human - i.e. the
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
  /** Pending debounced target-list push (see onTargetInfoChanged). */
  private infoPush?: NodeJS.Timeout

  constructor(
    private readonly client: CdpClient,
    /** Lists the identity's viewable page targets - the source for the viewer's tab picker. */
    private readonly listTargets: () => Promise<TargetSummary[]>,
  ) {}

  async addViewer(ws: WebSocket): Promise<void> {
    this.viewers.add(ws)
    // If there is nothing to cast, startCasting broadcasts the waiting state - and this viewer is already in
    // the set, so it receives it. No per-viewer send here or a joiner would get the message twice.
    await this.serialize(() => this.startCasting())
    if (this.sessionId && this.lastFrame && ws.readyState === ws.OPEN) {
      // Late joiner: paint it immediately from cache rather than waiting for a repaint that may never come.
      ws.send(this.lastFrame)
    }
    void this.pushTargets(ws)

    ws.on('message', (raw) => {
      let m: ViewerMessage
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (m.type === 'attach' && m.targetId) {
        void this.attachTo(m.targetId)
        return
      }
      void this.onInput(m, ws)
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
   * viewer's stop would tear down the cast underneath it - connected, live, and permanently blank.
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
      // No tab to cast - either none yet, or the LAST one was just closed/released. Every viewer must hear
      // this, not only joiners: without it, closing the final tab leaves the previous frame frozen on screen,
      // which reads as a live page. The target watcher calls back here when a tab opens.
      this.broadcast({ type: 'waiting', message: 'No open tab to view yet - allocate one to take over.' })
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
    this.client.on('Target.targetInfoChanged', this.onTargetInfoChanged)
  }

  private unwatchPages(): void {
    if (!this.watching) return
    this.watching = false
    this.client.off('Target.targetCreated', this.onTargetChange)
    this.client.off('Target.targetDestroyed', this.onTargetChange)
    this.client.off('Target.targetInfoChanged', this.onTargetInfoChanged)
    clearTimeout(this.infoPush)
    this.infoPush = undefined
  }

  private readonly onTargetChange = (): void => {
    if (this.viewers.size === 0) return
    void this.serialize(async () => {
      // A destroyed tab leaves a dead session behind; drop it so we re-pick a live one.
      if (this.sessionId && !(await this.sessionIsLive())) await this.stopCasting()
      if (!this.sessionId) await this.startCasting()
    }).then(() => this.pushTargets())
  }

  /**
   * A tab NAVIGATING is not a tab appearing, and only the latter used to reach the viewer. Without this a tab
   * allocated blank and then driven somewhere - by an agent, or by the address field right here - keeps its
   * stale entry in the strip forever: titled "Untitled tab", and, because the dashboard reads a blank URL as
   * "nothing loaded", with the live frame HIDDEN behind a placeholder while its frames stream in behind it.
   *
   * Debounced because `targetInfoChanged` fires repeatedly through a single navigation (each URL and title
   * change), and every push costs a `Target.getTargets` per viewer.
   */
  private readonly onTargetInfoChanged = (): void => {
    if (this.viewers.size === 0) return
    clearTimeout(this.infoPush)
    this.infoPush = setTimeout(() => {
      this.infoPush = undefined
      void this.pushTargets()
    }, TARGET_INFO_DEBOUNCE_MS)
    this.infoPush.unref?.()
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

  private async onInput(m: ViewerMessage, ws: WebSocket): Promise<void> {
    const sid = this.sessionId
    if (!sid) return
    const dw = this.lastMeta.deviceWidth
    const dh = this.lastMeta.deviceHeight
    const modifiers = m.modifiers ?? 0
    if (m.type === 'mouse') {
      const type = m.event === 'down' ? 'mousePressed' : m.event === 'up' ? 'mouseReleased' : 'mouseMoved'
      const buttons = m.buttons ?? 0
      await this.client
        .send(
          'Input.dispatchMouseEvent',
          {
            type,
            x: (m.nx ?? 0) * dw,
            y: (m.ny ?? 0) * dh,
            // A drag has to name the button it is dragging with, not just the held-buttons mask: Chrome extends
            // a selection on `mouseMoved` only when `button` says which one is down. With 'none' the press and
            // release land as a click and the drag between them does nothing - which is why selecting text by
            // dragging never worked here.
            button: m.button ?? (type === 'mouseMoved' ? heldButton(buttons) : 'none'),
            buttons,
            // Carries double- and triple-click through, which is how a word and a line get selected. Chrome
            // derives those from clickCount, so a hardcoded 1 made every click a single click.
            clickCount: type === 'mouseMoved' ? 0 : (m.clickCount ?? 1),
            modifiers,
          },
          sid,
        )
        .catch(() => {})
    } else if (m.type === 'wheel') {
      await this.client
        .send(
          'Input.dispatchMouseEvent',
          { type: 'mouseWheel', x: (m.nx ?? 0) * dw, y: (m.ny ?? 0) * dh, deltaX: m.dx, deltaY: m.dy, modifiers },
          sid,
        )
        .catch(() => {})
    } else if (m.type === 'key' && m.key) {
      const printable = m.key.length === 1
      const special = NON_PRINTABLE[m.key]
      // Suppress `text` while Ctrl/Meta is held: with it, Cmd+C types a literal "c" into the page before the
      // shortcut is ever considered. Shift/Alt are not suppressed - those DO produce text ("A", "ß").
      const shortcut = (modifiers & 2) !== 0 || (modifiers & 4) !== 0
      const text = shortcut ? undefined : printable ? m.key : special?.text
      const down = m.phase === 'down'
      await this.client
        .send(
          'Input.dispatchKeyEvent',
          {
            type: down && text ? 'keyDown' : down ? 'rawKeyDown' : 'keyUp',
            key: m.key,
            code: m.code ?? (printable ? `Key${m.key.toUpperCase()}` : m.key),
            windowsVirtualKeyCode: m.keyCode ?? special?.keyCode ?? (printable ? m.key.toUpperCase().charCodeAt(0) : 0),
            modifiers,
            ...(text && down ? { text } : {}),
            // Editing commands the renderer executes directly (selectAll, delete, …). This is how Cmd+A works
            // without the browser-level shortcut handling that a synthetic key event never reaches.
            ...(down && m.action ? { commands: [m.action] } : {}),
          },
          sid,
        )
        .catch(() => {})
    } else if (m.type === 'clipboard') {
      await this.onClipboard(m, ws, sid)
    } else if (m.type === 'paste' && typeof m.text === 'string') {
      // insertText, not synthesized keystrokes: it delivers the whole string as one composed input (correct for
      // multi-line and non-ASCII), and it is what a real paste looks like to the page.
      await this.client.send('Input.insertText', { text: m.text }, sid).catch(() => {})
    }
  }

  /**
   * Copy/cut. The clipboard is the BROWSER's, not the renderer's, so a synthesized Cmd+C reaches the page and
   * does nothing - there is no browser UI layer here to act on it. Instead the hub reads the page's selection
   * and hands the text back to the viewer, which puts it on the *operator's own* clipboard. Cut then deletes
   * the selection through the renderer's editing command.
   *
   * The text crosses the socket the operator is already watching pixels on, so this exposes nothing that the
   * screencast does not - but it is worth knowing that it is text, and therefore greppable, where a frame is
   * not. Only the requesting viewer is answered, never broadcast.
   */
  private async onClipboard(m: ViewerMessage, ws: WebSocket, sid: string): Promise<void> {
    let text = ''
    try {
      const res = await this.client.send<{ result?: { value?: string } }>(
        'Runtime.evaluate',
        { expression: READ_SELECTION_JS, returnByValue: true },
        sid,
      )
      text = res.result?.value ?? ''
    } catch {
      return
    }
    if (m.action === 'cut' && text) {
      await this.client
        .send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', windowsVirtualKeyCode: 46, commands: ['delete'] }, sid)
        .catch(() => {})
      await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', windowsVirtualKeyCode: 46 }, sid).catch(() => {})
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'clipboard', text }))
  }
}
