// Screencast + input-injection helpers over CDP. This is what Steel's viewer and Browserbase's live view do:
// Page.startScreencast (JPEG, ack-throttled) for the picture, Input.dispatch* for human control (which
// produces isTrusted events — indistinguishable from a real user). Neither method is on rebrowser's
// sensitive-methods list, and screencast runs no JS in the page. See docs/PRD.md §4/§7 (S4).

import { CdpClient } from './cdp-client.ts'

export interface FrameMetadata {
  offsetTop: number
  pageScaleFactor: number
  deviceWidth: number
  deviceHeight: number
  scrollOffsetX: number
  scrollOffsetY: number
  timestamp?: number
}

export type FrameHandler = (jpegBase64: string, metadata: FrameMetadata) => void

/** Start an ack-throttled JPEG screencast on a session. Returns a stop() function. */
export async function startScreencast(
  client: CdpClient,
  sessionId: string,
  onFrame: FrameHandler,
  opts: { quality?: number; maxWidth?: number; maxHeight?: number } = {},
): Promise<() => Promise<void>> {
  client.on('Page.screencastFrame', (params, sid) => {
    if (sid !== sessionId) return
    // Ack immediately so Chrome keeps sending frames (the ack is the throttle).
    void client.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})
    onFrame(params.data as string, params.metadata as FrameMetadata)
  })
  await client.send(
    'Page.startScreencast',
    { format: 'jpeg', quality: opts.quality ?? 75, maxWidth: opts.maxWidth ?? 1600, maxHeight: opts.maxHeight ?? 1000, everyNthFrame: 1 },
    sessionId,
  )
  return async () => {
    await client.send('Page.stopScreencast', {}, sessionId).catch(() => {})
  }
}

// ── Input injection (all produce isTrusted events) ──────────────────────────────────────────────────────

export interface MouseInput {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle' | 'none'
  clickCount?: number
  buttons?: number
}

export function dispatchMouse(client: CdpClient, sessionId: string, i: MouseInput): Promise<unknown> {
  return client.send(
    'Input.dispatchMouseEvent',
    {
      type: i.type,
      x: i.x,
      y: i.y,
      button: i.button ?? 'none',
      buttons: i.buttons ?? 0,
      clickCount: i.clickCount ?? (i.type === 'mouseMoved' ? 0 : 1),
    },
    sessionId,
  )
}

export interface KeyInput {
  type: 'keyDown' | 'keyUp'
  key: string
  code?: string
  keyCode?: number
}

// Minimal mapping sufficient for logins (printable chars + Enter/Tab/Backspace/arrows).
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

export function dispatchKey(client: CdpClient, sessionId: string, i: KeyInput): Promise<unknown> {
  const printable = i.key.length === 1
  const special = NON_PRINTABLE[i.key]
  const text = printable ? i.key : special?.text
  return client.send(
    'Input.dispatchKeyEvent',
    {
      type: i.type === 'keyDown' && text ? 'keyDown' : i.type,
      key: i.key,
      code: i.code ?? (printable ? `Key${i.key.toUpperCase()}` : i.key),
      windowsVirtualKeyCode: i.keyCode ?? special?.keyCode ?? (printable ? i.key.toUpperCase().charCodeAt(0) : 0),
      ...(text && i.type === 'keyDown' ? { text } : {}),
    },
    sessionId,
  )
}
