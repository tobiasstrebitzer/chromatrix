import * as React from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { gateway } from '@/lib/useGateway'
import { fitTakeoverViewport } from '@/lib/viewportFit'
import { usePollTick } from '@/lib/usePollTick'
import { usePersistedState } from '@/lib/usePersistedState'
import { useSessionsContext } from '@/lib/sessionsContext'
import type { GatewaySettings } from '@/lib/types'
import { toast } from '@/components/ui/Sonner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SessionRow } from '@/components/sessions/SessionRow'
import { DeleteSessionDialog } from '@/components/sessions/DeleteSessionDialog'

/** How often tab thumbnails refresh. One CDP screenshot per visible tab per tick - cheap, but not free. */
const THUMBNAIL_POLL_MS = 5000

/**
 * Sessions - provisioning *and* monitoring in one surface.
 *
 * Each identity is a full-width row; expanding it shows its leased tabs as cards carrying a live screenshot,
 * so this page answers "what are my agents actually looking at right now" without a trip to takeover. The
 * thumbnails are polled stills rather than a screencast on purpose: a screencast is repaint-driven and
 * needs the tab composited/foregrounded, which is fine for one focused tab and wrong for a whole grid.
 */
export function SessionsView() {
  const { sessions, error, refresh } = useSessionsContext()
  const navigate = useNavigate()
  const tick = usePollTick(THUMBNAIL_POLL_MS)

  const [failure, setFailure] = React.useState<string | undefined>(undefined)
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set())
  const [collapsed, setCollapsed] = usePersistedState<string[]>('chromatrix.sessions.collapsed', [], (v) =>
    Array.isArray(v),
  )
  // Headless is a property of a *launch*, not of the session, so it can't live on the identity - but re-picking
  // it on every start would be tedious, so the dashboard remembers the last choice.
  const [headless, setHeadless] = usePersistedState<boolean>(
    'chromatrix.sessions.headless',
    true,
    (v) => typeof v === 'boolean',
  )
  /** Identity whose delete confirmation is open, if any. */
  const [deleting, setDeleting] = React.useState<string | undefined>(undefined)
  // Read once: the dashboard needs to know whether a global default viewport exists before it offers its own
  // fit-the-pane size for new tabs.
  const [settings, setSettings] = React.useState<GatewaySettings | undefined>(undefined)
  React.useEffect(() => {
    void gateway.getSettings().then(setSettings, () => setSettings({}))
  }, [])

  // Confirmations are transient and go to a toast; failures stay on the page until dismissed or superseded.
  // Auto-hiding a real error is how you lose the only explanation of why something didn't work, so a failed
  // mutation is deliberately NOT a toast.
  const flash = (msg: string) => toast(msg)
  const fail = (e: unknown) => setFailure(e instanceof Error ? e.message : String(e))

  // Per-action busy rather than one global flag: starting identity A must not grey out stopping identity B,
  // and each control can show its own spinner. The ref is the source of truth (a double-click lands two calls
  // in the same render, where state alone would let both through); the state is its render mirror.
  const inFlight = React.useRef(new Set<string>())
  const run = async (key: string, fn: () => Promise<void>) => {
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    setBusy(new Set(inFlight.current))
    setFailure(undefined)
    try {
      await fn()
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      inFlight.current.delete(key)
      setBusy(new Set(inFlight.current))
    }
  }

  const toggle = (identity: string) =>
    setCollapsed((prev) => (prev.includes(identity) ? prev.filter((i) => i !== identity) : [...prev, identity]))

  const goTakeover = (identity: string, targetId?: string) =>
    void navigate({ to: '/takeover/$identity', params: { identity }, search: targetId ? { target: targetId } : {} })

  return (
    <div className='mx-auto w-full max-w-7xl px-6 py-6'>
      <header className='mb-4 flex items-end justify-between gap-4'>
        <div>
          <h1 className='text-display-sm font-semibold tracking-tight text-text'>Sessions</h1>
          <p className='mt-1 text-body-sm text-muted-foreground'>
            One real Chrome per identity. Lease exclusive tabs for your agents and watch what they're doing.
          </p>
        </div>
      </header>

      {error && <Banner>{`Gateway unreachable - ${error}`}</Banner>}
      {failure && <Banner onDismiss={() => setFailure(undefined)}>{failure}</Banner>}

      <div>
        {sessions === undefined ? (
          <Placeholder>Loading sessions…</Placeholder>
        ) : (
          <div className='divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface'>
            {sessions.map((s) => (
              <SessionRow
                key={s.identity}
                session={s}
                expanded={!collapsed.includes(s.identity)}
                onToggle={() => toggle(s.identity)}
                tick={tick}
                busy={busy}
                onTakeover={(targetId) => goTakeover(s.identity, targetId)}
                onHealth={() =>
                  void run(`health:${s.identity}`, async () => {
                    const h = await gateway.health(s.identity)
                    flash(`${s.identity}: ${h.product}`)
                  })
                }
                headless={headless}
                onHeadlessChange={setHeadless}
                onStart={() =>
                  void run(`start:${s.identity}`, async () => {
                    await gateway.startIdentity(s.identity, headless)
                    flash(`Started “${s.identity}”.`)
                  })
                }
                onStop={() =>
                  void run(`stop:${s.identity}`, async () => {
                    await gateway.stopIdentity(s.identity)
                    flash(`Stopped “${s.identity}”.`)
                  })
                }
                onDelete={() => setDeleting(s.identity)}
                onAllocate={(agentId, url) =>
                  void run(`tab:${s.identity}`, async () => {
                    // Size precedence lives on the gateway (explicit → global default → Chrome's own). The
                    // dashboard only supplies the fit-the-takeover-pane size, and only when no global default
                    // exists - otherwise it would silently outrank the user's setting.
                    await gateway.allocateTab(
                      s.identity,
                      agentId,
                      url,
                      settings?.defaultViewport ? undefined : fitTakeoverViewport(),
                    )
                  })
                }
                onRelease={(targetId) =>
                  void run(`release:${s.identity}:${targetId}`, async () => {
                    await gateway.releaseTab(s.identity, targetId)
                  })
                }
              />
            ))}
            <CreateSessionRow
              busy={busy.has('create')}
              onCreate={(id) =>
                run('create', async () => {
                  await gateway.createIdentity(id)
                  flash(`Created “${id}”. Start it when you're ready.`)
                })
              }
            />
          </div>
        )}
      </div>

      {/* Mounted once at the view level rather than per row: it's a modal, so only one can ever be open, and
          keying it by identity resets its typed-confirmation state when the target changes. */}
      {deleting && (
        <DeleteSessionDialog
          key={deleting}
          identity={deleting}
          open
          onOpenChange={(open) => !open && setDeleting(undefined)}
          onConfirm={() => {
            const id = deleting
            void run(`delete:${id}`, async () => {
              await gateway.deleteIdentity(id)
              flash(`Deleted “${id}”.`)
            })
          }}
        />
      )}
    </div>
  )
}

/**
 * A failure that stays put. Transient confirmations are toasts (see Sonner); this is only for things the user
 * needs to still be able to read a minute later - a mutation that failed, or a gateway we can't reach.
 */
function Banner({ onDismiss, children }: { onDismiss?: () => void; children: React.ReactNode }) {
  return (
    <div
      role='alert'
      className='mb-3 flex items-start gap-2 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-body-sm text-danger'>
      <AlertTriangle className='mt-0.5 shrink-0' />
      <span className='min-w-0 flex-1 break-words'>{children}</span>
      {onDismiss && (
        <button type='button' onClick={onDismiss} aria-label='Dismiss' className='shrink-0 opacity-70 hover:opacity-100'>
          <X className='size-4' />
        </button>
      )}
    </div>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className='rounded-lg border border-dashed border-border px-6 py-12 text-center'>
      <p className='text-body-sm text-muted-foreground'>{children}</p>
    </div>
  )
}

/**
 * The last row of the session list: create a new session. Deliberately shaped like the "New tab" placeholder
 * card one level down - the next empty slot in the list you're already reading, rather than a separate form
 * above it.
 *
 * Creating does NOT start it. A session is a long-lived thing (its profile dir holds a real signed-in
 * browser), so bringing one into existence and spending a Chrome process on it are separate decisions - the
 * new row lands in the list as `stopped`, with a Start button on it.
 */
function CreateSessionRow({ busy, onCreate }: { busy: boolean; onCreate: (id: string) => void }) {
  const [id, setId] = React.useState('')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = id.trim()
        if (!trimmed || busy) return
        onCreate(trimmed)
        setId('')
      }}
      className='flex flex-wrap items-center gap-2 bg-bg px-3 py-2.5'>
      <Plus className='size-4 shrink-0 text-fg-4' aria-hidden />
      <Input
        name='identity'
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder='new identity id - lowercase slug, e.g. acme-1'
        className='min-w-56 flex-1 font-mono'
        aria-label='New identity id'
      />
      <Button type='submit' disabled={busy || !id.trim()}>
        <Plus />
        {busy ? 'Creating…' : 'Create session'}
      </Button>
    </form>
  )
}
