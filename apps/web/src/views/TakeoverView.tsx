import * as React from 'react'
import { CornerDownLeft, Globe, Keyboard, Loader2, MonitorPlay, Scan, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useSessionsContext } from '@/lib/sessionsContext'
import { gateway } from '@/lib/useGateway'
import { usePersistedState } from '@/lib/usePersistedState'
import { clampViewport, rememberTakeoverArea } from '@/lib/viewportFit'
import type { TargetSummary, Viewport } from '@/lib/types'
import { cn } from '@/lib/utils'
import { toast } from '@/components/ui/Sonner'
import { Badge } from '@/components/ui/Badge'
import { BlankTab } from '@/components/ui/BlankTab'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/Select'

// Live-view + human takeover. Connects to the gateway's raw-WS /takeover/<identity>/ws, renders the CDP
// screencast frames, and forwards mouse/keyboard/wheel as Input.dispatch* (isTrusted) events - the S4
// mechanism, in the dashboard. Without an identity it shows a picker of running sessions.
export function TakeoverView({ identity, target }: { identity?: string; target?: string }) {
  if (!identity) return <TakeoverPicker />
  return <Screencast identity={identity} target={target} />
}

function TakeoverPicker() {
  const { sessions } = useSessionsContext()
  const navigate = useNavigate()
  // Only running sessions can be taken over - a stopped one has no Chrome to screencast. The session list
  // includes stopped sessions now, so this has to filter rather than take it wholesale.
  const running = sessions?.filter((s) => s.state === 'running')
  return (
    <div className='mx-auto w-full max-w-3xl px-6 py-6'>
      <header className='mb-5'>
        <h1 className='text-display-sm font-semibold text-text'>Takeover</h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>
          Drive a running identity's window yourself - click and type directly on the live frame. Use this to
          complete a one-time login or clear an interactive human-verification gate.
        </p>
      </header>
      {running === undefined ? (
        <p className='text-body-sm text-muted-foreground'>Loading sessions…</p>
      ) : running.length === 0 ? (
        <div className='rounded-lg border border-dashed border-border-light bg-surface px-6 py-12 text-center'>
          <p className='text-body-sm text-muted-foreground'>No running sessions to take over. Start one from Sessions.</p>
        </div>
      ) : (
        <ul className='grid gap-2'>
          {running.map((s) => (
            <li key={s.identity}>
              <button
                type='button'
                onClick={() => void navigate({ to: '/takeover/$identity', params: { identity: s.identity } })}
                className='flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-light hover:bg-surface-hover'>
                <MonitorPlay className='size-4 text-accent' />
                <span className='font-mono text-body-sm text-text'>{s.identity}</span>
                <Badge variant='neutral' className='ml-auto'>{s.tabs} tabs</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Status = 'connecting' | 'live' | 'disconnected'

/**
 * How the frame maps to the stage: scaled down to fit it, or shown pixel-for-pixel (scroll to pan). 1:1 is
 * what you want when a fitted frame renders text too small to read a challenge or an OTP prompt.
 */
type Zoom = 'fit' | 'actual'

function Screencast({ identity, target }: { identity: string; target?: string }) {
  const navigate = useNavigate()
  const { sessions } = useSessionsContext()
  const imgRef = React.useRef<HTMLImageElement>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  // Which `?target=` we have already asked the hub for. The request can only go out once the socket has
  // pushed its target list, and the push repeats on every target change - without this the deep link would
  // re-attach on every push and permanently override the human's own tab selection.
  const requestedTarget = React.useRef<string | undefined>(undefined)
  const [status, setStatus] = React.useState<Status>('connecting')
  const [frames, setFrames] = React.useState(0)
  const [waiting, setWaiting] = React.useState<string | null>(null)
  const [targets, setTargets] = React.useState<TargetSummary[]>([])
  const [activeTargetId, setActiveTargetId] = React.useState<string | undefined>(undefined)
  const [zoom, setZoom] = usePersistedState<Zoom>('chromatrix.takeover.zoom', 'fit', (v) => v === 'fit' || v === 'actual')
  /** Whether the frame owns the keyboard right now - drives the "click to type" affordance. */
  const [kbFocus, setKbFocus] = React.useState(false)
  const paneRef = React.useRef<HTMLDivElement>(null)

  // Record the pane's real size so a tab created later from Sessions - where this pane isn't mounted and so
  // can't be measured - can be sized to fit it exactly instead of from an estimate.
  React.useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const publish = () => rememberTakeoverArea({ width: pane.clientWidth, height: pane.clientHeight })
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(pane)
    return () => ro.disconnect()
  }, [])

  React.useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    const ws = new WebSocket(`${proto}${location.host}/takeover/${identity}/ws`)
    wsRef.current = ws
    ws.onopen = () => setStatus('live')
    ws.onclose = () => setStatus('disconnected')
    ws.onerror = () => setStatus('disconnected')
    ws.onmessage = (e) => {
      let m: {
        type?: string
        data?: string
        text?: string
        message?: string
        targets?: TargetSummary[]
        activeTargetId?: string
      }
      try {
        m = JSON.parse(e.data as string)
      } catch {
        return
      }
      if (m.type === 'frame' && m.data && imgRef.current) {
        imgRef.current.src = `data:image/jpeg;base64,${m.data}`
        setWaiting(null)
        setFrames((n) => n + 1)
      } else if (m.type === 'waiting') {
        setWaiting(m.message ?? 'Waiting for a tab…')
      } else if (m.type === 'clipboard') {
        // A successful copy stays silent - that is what copying feels like everywhere else. Only the two
        // failure modes say anything, because both are otherwise indistinguishable from a working copy.
        const text = m.text ?? ''
        if (!text) {
          toast('Nothing selected', { description: 'Select something in the page first, then copy.' })
        } else {
          void writeClipboard(text).then((ok) => {
            if (!ok) toast.error('Could not write to your clipboard', { description: 'Your browser refused clipboard access.' })
          })
        }
      } else if (m.type === 'targets') {
        const list = m.targets ?? []
        setTargets(list)
        setActiveTargetId(m.activeTargetId)
        if (target && requestedTarget.current !== target && list.some((t) => t.targetId === target)) {
          requestedTarget.current = target
          ws.send(JSON.stringify({ type: 'attach', targetId: target }))
        }
      }
    }
    return () => ws.close()
  }, [identity, target])

  // A tab that has never navigated produces a blank white frame, which is indistinguishable from a broken
  // viewer. Show the same "No URL loaded" state the Sessions cards use, and let the address field be the way
  // out of it.
  const activeTarget = targets.find((t) => t.targetId === activeTargetId)
  const blankTab = waiting === null && activeTarget !== undefined && isBlank(activeTarget.url)
  const frameShown = waiting === null && !blankTab

  // Hand the keyboard to the frame as soon as there is one to drive - today you had to *know* to click it
  // first. Only when nothing else holds focus though: yanking it out of the address field mid-URL would
  // trade one undiscoverability for a worse one.
  React.useEffect(() => {
    if (status !== 'live' || !frameShown) return
    const focused = document.activeElement
    if (focused && focused !== document.body && focused !== imgRef.current) return
    imgRef.current?.focus({ preventScroll: true })
  }, [status, frameShown, activeTargetId])

  const send = React.useCallback((o: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }, [])
  // Normalized against the <img> itself rather than the event target, so a drag that leaves the frame still
  // reports coordinates (clamped to the edge) instead of stopping dead.
  const norm = React.useCallback((e: { clientX: number; clientY: number }) => {
    const r = imgRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return { nx: 0, ny: 0 }
    return {
      nx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      ny: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }, [])
  const BTN = ['left', 'middle', 'right'] as const

  /**
   * Set when a Cmd+V has been let through and we are waiting for the browser to deliver the `paste` event
   * it implies. If that never arrives, the fallback below runs - a paste that silently does nothing is the
   * single worst outcome here, and is exactly how the first version of this shipped.
   */
  const pasteWatchdog = React.useRef<number | undefined>(undefined)

  // Paste comes from the browser's own event rather than `navigator.clipboard.readText()`, which needs a
  // permission the event does not. Bound to the document because a `paste` event is not delivered to a
  // non-editable element like our <img> - hence gated on the frame holding focus, or a paste into the
  // address field would be forwarded to the page as well.
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (document.activeElement !== imgRef.current) return
      e.preventDefault()
      window.clearTimeout(pasteWatchdog.current)
      pasteWatchdog.current = undefined
      const text = e.clipboardData?.getData('text/plain')
      if (text) send({ type: 'paste', text })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [send])

  /** Cmd/Ctrl+V. Separated because it is the one shortcut that must NOT be preventDefault()ed. */
  const isPasteShortcut = (e: React.KeyboardEvent): boolean =>
    (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'v'

  /** Let the keystroke run its default course, but notice if no paste event follows it. */
  const armPasteWatchdog = (): void => {
    window.clearTimeout(pasteWatchdog.current)
    pasteWatchdog.current = window.setTimeout(() => {
      pasteWatchdog.current = undefined
      // The browser declined to produce a paste event. Ask for the clipboard directly - this needs a
      // permission, which is why it is the fallback and not the primary path.
      void navigator.clipboard.readText().then(
        (text) => {
          if (text) send({ type: 'paste', text })
        },
        () =>
          toast.error('Could not paste', {
            description: 'Your browser blocked clipboard access. Click the page and try again.',
          }),
      )
    }, 250)
  }

  /**
   * Clipboard shortcuts, which cannot survive being forwarded as keystrokes.
   *
   * Cmd/Ctrl+C, +X and +V are handled by the *browser*, not by the page - so a synthetic key event delivered
   * into the renderer reaches the page and nothing acts on it. Each therefore becomes an explicit round trip
   * instead. Returns true when it handled the key, so the raw keystroke is not also forwarded.
   */
  const onClipboardShortcut = (e: React.KeyboardEvent): boolean => {
    const accel = e.metaKey || e.ctrlKey
    if (!accel || e.altKey) return false
    switch (e.key.toLowerCase()) {
      case 'c':
      case 'x':
        // The hub reads the page's selection and sends the text back; the reply handler puts it on this
        // machine's clipboard. Asynchronous by nature - there is a real page on the other side of it.
        send({ type: 'clipboard', action: e.key.toLowerCase() === 'c' ? 'copy' : 'cut' })
        return true
      case 'a':
        // Select-all IS reachable in the renderer, as an editing command carried on the key event.
        send({ type: 'key', phase: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: cdpModifiers(e), action: 'selectAll' })
        send({ type: 'key', phase: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: cdpModifiers(e) })
        return true
      default:
        // Cmd+V is deliberately absent: it is intercepted before preventDefault() runs (see onKeyDown).
        return false
    }
  }

  /**
   * Press-drag-release, tracked on the WINDOW rather than the frame.
   *
   * A selection drag routinely wanders off the image - past its edge, over the toolbar - and `mousemove`/
   * `mouseup` bound to the <img> stop firing the moment it does. The release would then never be sent and the
   * remote page would be left with the button still down. Listening on the window for the duration of the drag
   * is what makes "click, drag past the edge, let go" behave like a real selection.
   */
  const onFrameMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).focus()
    const button = BTN[e.button] ?? 'left'
    const n = norm(e)
    send({ type: 'mouse', event: 'down', nx: n.nx, ny: n.ny, button, buttons: e.buttons, clickCount: e.detail || 1, modifiers: cdpModifiers(e) })

    const onMove = (ev: MouseEvent) => {
      const p = norm(ev)
      send({ type: 'mouse', event: 'move', nx: p.nx, ny: p.ny, button, buttons: ev.buttons, modifiers: cdpModifiers(ev) })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const p = norm(ev)
      send({ type: 'mouse', event: 'up', nx: p.nx, ny: p.ny, button, buttons: ev.buttons, clickCount: ev.detail || 1, modifiers: cdpModifiers(ev) })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className='flex h-full flex-col'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2'>
        <StatusDot status={status} />

        <IdentitySelect
          identity={identity}
          running={(sessions ?? []).filter((s) => s.state === 'running').map((s) => s.identity)}
          onChange={(id) => void navigate({ to: '/takeover/$identity', params: { identity: id } })}
        />

        <AddressField identity={identity} targetId={activeTargetId} targets={targets} />

        <ViewportControls identity={identity} targetId={activeTargetId} paneRef={paneRef} />

        <ZoomToggle zoom={zoom} onChange={setZoom} />

        <span className='text-label text-muted-foreground'>
          {status === 'live' ? `${frames} frames` : status}
        </span>
        <Button variant='ghost' size='sm' className='ml-auto' onClick={() => void navigate({ to: '/sessions' })}>
          Back to sessions
        </Button>
      </div>

      <TabStrip
        identity={identity}
        targets={targets}
        activeTargetId={activeTargetId}
        onSelect={(targetId) => send({ type: 'attach', targetId })}
      />

      {/* The viewer stage is a recessed well inside the frame, not a hardcoded black box - black is only
          correct in the dark theme, and in light it read as a hole punched through the page.

          Deliberately unpadded: the stage runs from the toolbar's edge to the frame's, and the frame's own
          `overflow-hidden rounded-xl` (AppShell) clips the bottom corners, so the live view sits in the panel
          rather than floating inside it. The padding was also silently wrong for auto-fit - `clientWidth`
          INCLUDES padding, so the fit sized Chrome's window to the padded box while `max-w-full` capped the
          image at the content box, leaving the stream permanently downscaled by the padding. */}
      <div ref={paneRef} className='grid min-h-0 flex-1 place-items-center overflow-hidden bg-[var(--bg-code)]'>
        {waiting !== null && (
          <div className='col-start-1 row-start-1 text-center'>
            <MonitorPlay className='mx-auto mb-3 size-8 text-muted-foreground' />
            <p className='text-body-sm text-muted-foreground'>{waiting}</p>
          </div>
        )}
        {blankTab && (
          <BlankTab className='col-start-1 row-start-1 size-full' />
        )}
        {/* The wrapper (not the img) carries visibility, because the img must stay mounted to catch frames
            arriving over the socket. `flex` + `m-auto` rather than grid centering: an overflowing child of a
            centered grid cell has its top-left clipped beyond reach, while flex auto-margins center when
            small AND stay scrollable when the 1:1 frame is larger than the stage. */}
        <div className={cn('col-start-1 row-start-1 size-full overflow-auto', frameShown ? 'flex' : 'hidden')}>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <img
            ref={imgRef}
            tabIndex={0}
            draggable={false}
            alt={`Live view of ${identity}`}
            // No radius, ring, or shadow: those framed it as a screenshot sitting *on* the stage. Now it fills
            // the stage and the panel's own radius does the clipping. The focus ring is inset so it isn't the
            // one thing the frame clips away.
            className={cn(
              'm-auto cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
              zoom === 'fit' && 'max-h-full max-w-full',
            )}
            onFocus={() => setKbFocus(true)}
            onBlur={() => setKbFocus(false)}
            onMouseMove={(e) => {
              // Hover only - once a button is down the window-level drag listeners own the move stream, and
              // both firing would double up on every event.
              if (e.buttons !== 0) return
              const n = norm(e)
              send({ type: 'mouse', event: 'move', nx: n.nx, ny: n.ny, buttons: 0, modifiers: cdpModifiers(e) })
            }}
            onMouseDown={onFrameMouseDown}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => {
              const n = norm(e)
              send({ type: 'wheel', nx: n.nx, ny: n.ny, dx: e.deltaX, dy: e.deltaY, modifiers: cdpModifiers(e) })
            }}
            onKeyDown={(e) => {
              // Cmd/Ctrl+V is the ONE key that must not be cancelled: preventDefault() on the keydown also
              // cancels the browser's default paste action, and with it the `paste` event that carries the
              // clipboard payload. Cancelling it is why copy worked and paste silently did nothing.
              if (isPasteShortcut(e)) {
                armPasteWatchdog()
                return
              }
              e.preventDefault()
              if (onClipboardShortcut(e)) return
              send({ type: 'key', phase: 'down', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) })
            }}
            onKeyUp={(e) => {
              // Matching the keydown: the page gets the inserted text, not a stray Cmd+V keyup.
              if (isPasteShortcut(e)) return
              e.preventDefault()
              send({ type: 'key', phase: 'up', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) })
            }}
          />
        </div>
        {/* The keyboard affordance. The frame only receives keystrokes while focused, and nothing about a
            screenshot-looking <img> says "click me first" - this pill does, and disappears once it's true. */}
        {frameShown && status === 'live' && !kbFocus && (
          <div className='pointer-events-none col-start-1 row-start-1 mb-3 flex items-center gap-1.5 self-end justify-self-center rounded-full border border-border bg-surface/90 px-3 py-1 text-label text-fg-2 shadow-(--shadow-lg)'>
            <Keyboard className='size-3.5' aria-hidden />
            Click the page to send keystrokes
          </div>
        )}
      </div>
    </div>
  )
}

/** A blank tab has no meaningful title; Chrome reports the literal string, which is noise in a picker. */
const isBlank = (url?: string) => !url || url === 'about:blank'

/** CDP's modifier bitmask. Without it the remote page sees every click and keystroke as unmodified. */
function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/**
 * Put text on the operator's own clipboard.
 *
 * `navigator.clipboard.writeText` is the real path but needs a secure context and can reject once the
 * keystroke's transient activation has lapsed - and this text arrives after a round trip to the page, so by
 * then it often has. The execCommand fallback is deprecated and still the only thing that works in that case.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // Off-screen but focusable: `display:none` or `hidden` would make the selection - and so the copy - a no-op.
    ta.setAttribute('style', 'position:fixed;top:-1000px;opacity:0')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

function tabLabel(t: TargetSummary): string {
  if (isBlank(t.url)) return 'Untitled tab'
  return t.title?.trim() || t.url
}

/** Session switcher - running identities only (switching to a stopped one would land on a dead viewer). */
function IdentitySelect({
  identity,
  running,
  onChange,
}: {
  identity: string
  running: string[]
  onChange: (identity: string) => void
}) {
  // Keep the current identity selectable even if it stops out from under us, so the trigger never goes blank.
  const options = running.includes(identity) ? running : [identity, ...running]
  return (
    <>
      <span className='sr-only' id='takeover-identity-label'>
        Session
      </span>
      <Select value={identity} onValueChange={(v) => typeof v === 'string' && v && v !== identity && onChange(v)}>
        <SelectTrigger aria-labelledby='takeover-identity-label' className='font-mono text-label'>
          {identity}
        </SelectTrigger>
        <SelectContent>
          {options.map((id) => (
            <SelectItem key={id} value={id}>
              <span className='font-mono text-label'>{id}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}

/**
 * Favicon for a tab strip entry, fetched straight from the page's origin (`/favicon.ico`) - the gateway has
 * no favicon knowledge, and the operator's browser is already looking at the site's pixels anyway. Falls back
 * to a globe for blank tabs, non-http schemes, and sites without one.
 */
function Favicon({ url }: { url?: string }) {
  const origin = React.useMemo(() => {
    if (isBlank(url)) return undefined
    try {
      const u = new URL(url!)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined
    } catch {
      return undefined
    }
  }, [url])
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => setFailed(false), [origin])
  if (!origin || failed) return <Globe className='size-3.5 shrink-0 text-fg-4' aria-hidden />
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=''
      draggable={false}
      className='size-3.5 shrink-0'
      onError={() => setFailed(true)}
    />
  )
}

/**
 * Browser-style tab strip: favicon, title, leasing agent, and - for leased tabs - an inline release. This is
 * the takeover view's real navigation; a dropdown made picking a tab a two-step guess.
 */
function TabStrip({
  identity,
  targets,
  activeTargetId,
  onSelect,
}: {
  identity: string
  targets: TargetSummary[]
  activeTargetId?: string
  onSelect: (targetId: string) => void
}) {
  const [releasing, setReleasing] = React.useState<string | undefined>(undefined)
  if (targets.length === 0) return null

  // Release = the gateway closes the tab and frees the lease. Only leased tabs offer it: an unleased page
  // (a popup the human opened, say) has no lease to release and no route that closes it.
  const release = async (t: TargetSummary) => {
    if (releasing) return
    setReleasing(t.targetId)
    try {
      await gateway.releaseTab(identity, t.targetId)
      // No local list surgery: the hub watches Target.targetDestroyed and pushes the fresh target list.
    } catch (err) {
      toast.error('Could not release tab', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setReleasing(undefined)
    }
  }

  return (
    <div role='tablist' aria-label='Tabs' className='flex items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1.5'>
      {targets.map((t) => {
        const active = t.targetId === activeTargetId
        return (
          <div
            key={t.targetId}
            className={cn(
              'group flex max-w-72 min-w-0 shrink-0 items-center rounded-md border transition-colors',
              active ? 'border-border-strong bg-bg' : 'border-transparent hover:bg-surface-hover',
            )}>
            <button
              type='button'
              role='tab'
              aria-selected={active}
              title={isBlank(t.url) ? 'about:blank' : t.url}
              onClick={() => !active && onSelect(t.targetId)}
              className='flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring'>
              <Favicon url={t.url} />
              <span className={cn('truncate text-label', active ? 'font-medium text-fg-1' : 'text-fg-2')}>
                {tabLabel(t)}
              </span>
              {t.agentId && (
                <Badge variant='neutral' mono className='shrink-0'>
                  {t.agentId}
                </Badge>
              )}
            </button>
            {t.agentId && (
              <button
                type='button'
                onClick={() => void release(t)}
                disabled={releasing !== undefined}
                aria-label={`Release "${tabLabel(t)}"`}
                title='Release the lease and close this tab'
                className={cn(
                  'mr-1 grid size-5 shrink-0 place-items-center rounded-sm text-fg-4 opacity-0 transition-opacity',
                  'hover:bg-surface-hover hover:text-danger focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100',
                  releasing === t.targetId && 'opacity-100',
                )}>
                {releasing === t.targetId ? <Loader2 className='size-3 animate-spin' /> : <X className='size-3' />}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Fit-to-panel vs pixel-for-pixel. Segmented rather than a toggle button so the current mode is legible. */
function ZoomToggle({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom) => void }) {
  return (
    <div role='group' aria-label='Zoom' className='flex items-center rounded-md border border-border p-0.5'>
      {(['fit', 'actual'] as const).map((z) => (
        <button
          key={z}
          type='button'
          onClick={() => onChange(z)}
          aria-pressed={zoom === z}
          title={z === 'fit' ? 'Scale the frame to fit the panel' : 'Actual size - scroll to pan'}
          className={cn(
            'rounded-[5px] px-2 py-0.5 text-label transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
            zoom === z ? 'bg-surface-hover font-medium text-fg-1' : 'text-fg-3 hover:text-fg-1',
          )}>
          {z === 'fit' ? 'Fit' : '1:1'}
        </button>
      ))}
    </div>
  )
}

/**
 * Address field for the selected tab. The screencast shows only the page's content area - there is no browser
 * chrome in the frame - so without this a human in takeover can look at a tab but never steer it anywhere.
 */
function AddressField({
  identity,
  targetId,
  targets,
}: {
  identity: string
  targetId?: string
  targets: TargetSummary[]
}) {
  const current = targets.find((t) => t.targetId === targetId)
  const currentUrl = isBlank(current?.url) ? '' : (current?.url ?? '')
  const [draft, setDraft] = React.useState(currentUrl)
  const [editing, setEditing] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // Follow the tab while the user isn't mid-edit - the tab navigates on its own (agent activity, redirects,
  // link clicks in takeover), and clobbering a half-typed URL would be worse than showing a stale one.
  React.useEffect(() => {
    if (!editing) setDraft(currentUrl)
  }, [currentUrl, editing])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = draft.trim()
    if (!raw || !targetId || busy) return
    // Bare hostnames are what people actually type; assume https rather than rejecting them.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
    setBusy(true)
    try {
      await gateway.navigateTab(identity, targetId, url)
      setEditing(false)
    } catch (err) {
      toast.error('Could not navigate', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='flex min-w-0 flex-1 items-center gap-1'>
      <Input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setEditing(true)
        }}
        onBlur={() => setEditing(false)}
        disabled={!targetId || busy}
        placeholder='enter a URL to navigate this tab'
        aria-label='Tab URL'
        className='h-7 min-w-0 flex-1 font-mono text-label'
      />
      <Button type='submit' variant='ghost' size='icon-sm' disabled={!targetId || busy || !draft.trim()} aria-label='Go' title='Go'>
        <CornerDownLeft />
      </Button>
    </form>
  )
}

/**
 * Width/height of the *selected tab's* viewport, plus auto-fit.
 *
 * Every value shown comes back from the gateway rather than from what was typed: Chrome enforces a minimum
 * window size and silently clamps, so echoing the request would make the field disagree with the actual page.
 * Auto-fit measures the live pane, so "fills the available area exactly" stays true at any window size.
 */
function ViewportControls({
  identity,
  targetId,
  paneRef,
}: {
  identity: string
  targetId: string | undefined
  paneRef: React.RefObject<HTMLDivElement | null>
}) {
  const [viewport, setViewport] = React.useState<Viewport | undefined>(undefined)
  const [draft, setDraft] = React.useState<{ width: string; height: string }>({ width: '', height: '' })
  const [busy, setBusy] = React.useState(false)

  const show = (v: Viewport) => {
    setViewport(v)
    setDraft({ width: String(v.width), height: String(v.height) })
  }

  // Re-read whenever the selected tab changes - each tab has its own window and therefore its own size.
  React.useEffect(() => {
    if (!targetId) {
      setViewport(undefined)
      return
    }
    let alive = true
    void gateway.getTabViewport(identity, targetId).then(
      (v) => alive && show(v),
      () => alive && setViewport(undefined),
    )
    return () => {
      alive = false
    }
  }, [identity, targetId])

  const apply = async (want: Viewport) => {
    if (!targetId || busy) return
    setBusy(true)
    try {
      const clamped = clampViewport(want)
      const got = await gateway.setTabViewport(identity, targetId, clamped.width, clamped.height)
      show(got)
      if (got.width !== Math.round(want.width) || got.height !== Math.round(want.height)) {
        toast(`Clamped to ${got.width}×${got.height}`, {
          description: "Chrome won't make a window smaller than that.",
        })
      }
    } catch (e) {
      toast.error('Could not resize tab', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  const autoFit = () => {
    const pane = paneRef.current
    if (!pane) return
    void apply({ width: pane.clientWidth, height: pane.clientHeight })
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const w = Number(draft.width)
    const h = Number(draft.height)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
    void apply({ width: w, height: h })
  }

  const disabled = !targetId || busy

  return (
    <form onSubmit={submit} className='flex items-center gap-1'>
      <Input
        value={draft.width}
        onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))}
        disabled={disabled}
        inputMode='numeric'
        aria-label='Viewport width'
        title='Viewport width (CSS px)'
        className='h-7 w-16 px-1.5 text-center font-mono text-label'
      />
      <span className='text-label text-fg-4' aria-hidden>
        ×
      </span>
      <Input
        value={draft.height}
        onChange={(e) => setDraft((d) => ({ ...d, height: e.target.value }))}
        disabled={disabled}
        inputMode='numeric'
        aria-label='Viewport height'
        title='Viewport height (CSS px)'
        className='h-7 w-16 px-1.5 text-center font-mono text-label'
      />
      <Button type='submit' variant='outline' size='sm' disabled={disabled}>
        Resize
      </Button>
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        onClick={autoFit}
        disabled={disabled}
        aria-label='Fit tab to the viewer area'
        title='Fit tab to the viewer area'>
        <Scan />
      </Button>
      {viewport === undefined && targetId && <span className='text-label text-fg-4'>size unknown</span>}
    </form>
  )
}

function StatusDot({ status }: { status: Status }) {
  const color = status === 'live' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger'
  return <span className={`size-2 rounded-full ${color}`} aria-label={status} />
}
