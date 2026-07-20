import * as React from 'react'
import { CornerDownLeft, MonitorPlay, Scan } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useSessionsContext } from '@/lib/sessionsContext'
import { gateway } from '@/lib/useGateway'
import { clampViewport, rememberTakeoverArea } from '@/lib/viewportFit'
import type { TargetSummary, Viewport } from '@/lib/types'
import { toast } from '@/components/ui/Sonner'
import { Badge } from '@/components/ui/Badge'
import { BlankTab } from '@/components/ui/BlankTab'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/Select'

// Live-view + human takeover. Connects to the gateway's raw-WS /takeover/<identity>/ws, renders the CDP
// screencast frames, and forwards mouse/keyboard/wheel as Input.dispatch* (isTrusted) events — the S4
// mechanism, in the dashboard. Without an identity it shows a picker of running sessions.
export function TakeoverView({ identity, target }: { identity?: string; target?: string }) {
  if (!identity) return <TakeoverPicker />
  return <Screencast identity={identity} target={target} />
}

function TakeoverPicker() {
  const { sessions } = useSessionsContext()
  const navigate = useNavigate()
  // Only running sessions can be taken over — a stopped one has no Chrome to screencast. The session list
  // includes stopped sessions now, so this has to filter rather than take it wholesale.
  const running = sessions?.filter((s) => s.state === 'running')
  return (
    <div className='mx-auto w-full max-w-3xl px-6 py-6'>
      <header className='mb-5'>
        <h1 className='text-display-sm font-semibold text-text'>Takeover</h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>
          Drive a running identity's window yourself — click and type directly on the live frame. Use this to
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

function Screencast({ identity, target }: { identity: string; target?: string }) {
  const navigate = useNavigate()
  const { sessions } = useSessionsContext()
  const imgRef = React.useRef<HTMLImageElement>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  // Which `?target=` we have already asked the hub for. The request can only go out once the socket has
  // pushed its target list, and the push repeats on every target change — without this the deep link would
  // re-attach on every push and permanently override the human's own tab selection.
  const requestedTarget = React.useRef<string | undefined>(undefined)
  const [status, setStatus] = React.useState<Status>('connecting')
  const [frames, setFrames] = React.useState(0)
  const [waiting, setWaiting] = React.useState<string | null>(null)
  const [targets, setTargets] = React.useState<TargetSummary[]>([])
  const [activeTargetId, setActiveTargetId] = React.useState<string | undefined>(undefined)
  const paneRef = React.useRef<HTMLDivElement>(null)

  // Record the pane's real size so a tab created later from Sessions — where this pane isn't mounted and so
  // can't be measured — can be sized to fit it exactly instead of from an estimate.
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

  const send = (o: unknown) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o))
  }
  const norm = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return {
      nx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      ny: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }
  const BTN = ['left', 'middle', 'right'] as const

  return (
    <div className='flex h-full flex-col'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-2'>
        <StatusDot status={status} />

        <label className='sr-only' htmlFor='takeover-identity'>
          Session
        </label>
        <select
          id='takeover-identity'
          value={identity}
          onChange={(e) => void navigate({ to: '/takeover/$identity', params: { identity: e.target.value } })}
          className='h-7 rounded-md border border-border bg-bg px-2 font-mono text-label text-text outline-none focus-visible:ring-2 focus-visible:ring-accent'>
          {/* Running only — switching to a stopped session would land on a viewer with nothing to show. The
              fallback below still keeps the current identity selectable if it stops out from under us. */}
          {(sessions ?? [])
            .filter((s) => s.state === 'running')
            .map((s) => (
              <option key={s.identity} value={s.identity}>
                {s.identity}
              </option>
            ))}
          {!sessions?.some((s) => s.identity === identity && s.state === 'running') && (
            <option value={identity}>{identity}</option>
          )}
        </select>

        <TabPicker
          targets={targets}
          activeTargetId={activeTargetId}
          onSelect={(targetId) => send({ type: 'attach', targetId })}
        />

        <AddressField identity={identity} targetId={activeTargetId} targets={targets} />

        <ViewportControls identity={identity} targetId={activeTargetId} paneRef={paneRef} />

        <span className='text-label text-muted-foreground'>
          {status === 'live' ? `${frames} frames · click / type on the frame to drive it` : status}
        </span>
        <Button variant='ghost' size='sm' className='ml-auto' onClick={() => void navigate({ to: '/sessions' })}>
          Back to sessions
        </Button>
      </div>

      {/* The viewer stage is a recessed well inside the frame, not a hardcoded black box — black is only
          correct in the dark theme, and in light it read as a hole punched through the page.

          Deliberately unpadded: the stage runs from the toolbar's edge to the frame's, and the frame's own
          `overflow-hidden rounded-xl` (AppShell) clips the bottom corners, so the live view sits in the panel
          rather than floating inside it. The padding was also silently wrong for auto-fit — `clientWidth`
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
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <img
          ref={imgRef}
          tabIndex={0}
          draggable={false}
          alt={`Live view of ${identity}`}
          hidden={waiting !== null || blankTab}
          // No radius, ring, or shadow: those framed it as a screenshot sitting *on* the stage. Now it fills
          // the stage and the panel's own radius does the clipping. The focus ring is inset so it isn't the
          // one thing the frame clips away — it's the only cue that keystrokes will land on the page.
          className='col-start-1 row-start-1 max-h-full max-w-full cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset'
          onMouseMove={(e) => {
            const n = norm(e)
            send({ type: 'mouse', event: 'move', nx: n.nx, ny: n.ny, buttons: e.buttons })
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).focus()
            const n = norm(e)
            send({ type: 'mouse', event: 'down', nx: n.nx, ny: n.ny, button: BTN[e.button] ?? 'left', buttons: e.buttons })
          }}
          onMouseUp={(e) => {
            e.preventDefault()
            const n = norm(e)
            send({ type: 'mouse', event: 'up', nx: n.nx, ny: n.ny, button: BTN[e.button] ?? 'left', buttons: e.buttons })
          }}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => {
            const n = norm(e)
            send({ type: 'wheel', nx: n.nx, ny: n.ny, dx: e.deltaX, dy: e.deltaY })
          }}
          onKeyDown={(e) => {
            e.preventDefault()
            send({ type: 'key', phase: 'down', key: e.key, code: e.code, keyCode: e.keyCode })
          }}
          onKeyUp={(e) => {
            e.preventDefault()
            send({ type: 'key', phase: 'up', key: e.key, code: e.code, keyCode: e.keyCode })
          }}
        />
      </div>
    </div>
  )
}

/** A blank tab has no meaningful title; Chrome reports the literal string, which is noise in a picker. */
const isBlank = (url?: string) => !url || url === 'about:blank'

function tabLabel(t: TargetSummary): string {
  if (isBlank(t.url)) return 'Untitled tab'
  return t.title?.trim() || t.url
}

/**
 * Tab picker. A native `<select>` can only render one flat string per row, which forced the old
 * `[agent-1] Some Page Title` mash-up; a real popup can show the agent, the page title and the URL as three
 * distinct fields, which is what you actually need to pick the right tab.
 */
function TabPicker({
  targets,
  activeTargetId,
  onSelect,
}: {
  targets: TargetSummary[]
  activeTargetId?: string
  onSelect: (targetId: string) => void
}) {
  const active = targets.find((t) => t.targetId === activeTargetId)

  return (
    <>
      <span className='sr-only' id='takeover-tab-label'>
        Tab
      </span>
      <Select
        value={activeTargetId ?? ''}
        onValueChange={(v) => typeof v === 'string' && v && onSelect(v)}
        disabled={targets.length === 0}>
        <SelectTrigger aria-labelledby='takeover-tab-label' className='min-w-56 max-w-80'>
          <span className='flex min-w-0 items-center gap-2'>
            {active?.agentId && (
              <Badge variant='neutral' mono className='shrink-0'>
                {active.agentId}
              </Badge>
            )}
            <span className='truncate'>{active ? tabLabel(active) : 'no tabs'}</span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {targets.map((t) => (
            <SelectItem key={t.targetId} value={t.targetId}>
              <span className='flex min-w-0 items-center gap-2'>
                {t.agentId && (
                  <Badge variant='neutral' mono className='shrink-0'>
                    {t.agentId}
                  </Badge>
                )}
                <span className='truncate font-medium'>{tabLabel(t)}</span>
              </span>
              <span className='truncate font-mono text-label text-fg-4'>{isBlank(t.url) ? 'about:blank' : t.url}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}

/**
 * Address field for the selected tab. The screencast shows only the page's content area — there is no browser
 * chrome in the frame — so without this a human in takeover can look at a tab but never steer it anywhere.
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

  // Follow the tab while the user isn't mid-edit — the tab navigates on its own (agent activity, redirects,
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

  // Re-read whenever the selected tab changes — each tab has its own window and therefore its own size.
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
