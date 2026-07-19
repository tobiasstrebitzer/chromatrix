import * as React from 'react'
import { MonitorPlay } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useSessionsContext } from '@/lib/sessionsContext'
import type { TargetSummary } from '@/lib/types'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

// Live-view + human takeover. Connects to the gateway's raw-WS /takeover/<identity>/ws, renders the CDP
// screencast frames, and forwards mouse/keyboard/wheel as Input.dispatch* (isTrusted) events — the S4
// mechanism, in the dashboard. Without an identity it shows a picker of running sessions.
export function TakeoverView({ identity }: { identity?: string }) {
  if (!identity) return <TakeoverPicker />
  return <Screencast identity={identity} />
}

function TakeoverPicker() {
  const { sessions } = useSessionsContext()
  const navigate = useNavigate()
  return (
    <div className='mx-auto w-full max-w-3xl px-6 py-6'>
      <header className='mb-5'>
        <h1 className='text-display-sm font-semibold text-text'>Takeover</h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>
          Drive a running identity's window yourself — click and type directly on the live frame. Use this to
          complete a one-time login or clear an interactive human-verification gate.
        </p>
      </header>
      {sessions === undefined ? (
        <p className='text-body-sm text-muted-foreground'>Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <div className='rounded-lg border border-dashed border-border-light bg-surface px-6 py-12 text-center'>
          <p className='text-body-sm text-muted-foreground'>No running sessions to take over. Start one from Sessions.</p>
        </div>
      ) : (
        <ul className='grid gap-2'>
          {sessions.map((s) => (
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

function Screencast({ identity }: { identity: string }) {
  const navigate = useNavigate()
  const { sessions } = useSessionsContext()
  const imgRef = React.useRef<HTMLImageElement>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<Status>('connecting')
  const [frames, setFrames] = React.useState(0)
  const [waiting, setWaiting] = React.useState<string | null>(null)
  const [targets, setTargets] = React.useState<TargetSummary[]>([])
  const [activeTargetId, setActiveTargetId] = React.useState<string | undefined>(undefined)

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
        setTargets(m.targets ?? [])
        setActiveTargetId(m.activeTargetId)
      }
    }
    return () => ws.close()
  }, [identity])

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
          {(sessions ?? []).map((s) => (
            <option key={s.identity} value={s.identity}>
              {s.identity}
            </option>
          ))}
          {!sessions?.some((s) => s.identity === identity) && <option value={identity}>{identity}</option>}
        </select>

        <label className='sr-only' htmlFor='takeover-tab'>
          Tab
        </label>
        <select
          id='takeover-tab'
          value={activeTargetId ?? ''}
          disabled={targets.length === 0}
          onChange={(e) => send({ type: 'attach', targetId: e.target.value })}
          className='h-7 max-w-96 rounded-md border border-border bg-bg px-2 text-label text-text outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'>
          {targets.length === 0 && <option value=''>no tabs</option>}
          {targets.map((t) => (
            <option key={t.targetId} value={t.targetId}>
              {t.agentId ? `[${t.agentId}] ` : ''}
              {t.title || t.url || 'untitled'}
            </option>
          ))}
        </select>

        <span className='text-label text-muted-foreground'>
          {status === 'live' ? `${frames} frames · click / type on the frame to drive it` : status}
        </span>
        <Button variant='ghost' size='sm' className='ml-auto' onClick={() => void navigate({ to: '/sessions' })}>
          Back to sessions
        </Button>
      </div>

      <div className='grid min-h-0 flex-1 place-items-center bg-black/95 p-4'>
        {waiting !== null && (
          <div className='col-start-1 row-start-1 text-center'>
            <MonitorPlay className='mx-auto mb-3 size-8 text-muted-foreground' />
            <p className='text-body-sm text-muted-foreground'>{waiting}</p>
          </div>
        )}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <img
          ref={imgRef}
          tabIndex={0}
          draggable={false}
          alt={`Live view of ${identity}`}
          hidden={waiting !== null}
          className='col-start-1 row-start-1 max-h-full max-w-full cursor-crosshair rounded-sm shadow-(--shadow-lg) outline-none ring-1 ring-border focus-visible:ring-2 focus-visible:ring-accent'
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

function StatusDot({ status }: { status: Status }) {
  const color = status === 'live' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-danger'
  return <span className={`size-2 rounded-full ${color}`} aria-label={status} />
}
