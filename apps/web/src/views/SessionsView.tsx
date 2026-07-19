import * as React from 'react'
import { AlertTriangle, Play, Plus, X } from 'lucide-react'
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

/** How often tab thumbnails refresh. One CDP screenshot per visible tab per tick — cheap, but not free. */
const THUMBNAIL_POLL_MS = 5000

/**
 * Sessions — provisioning *and* monitoring in one surface.
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
  const [busy, setBusy] = React.useState<string | undefined>(undefined)
  const [collapsed, setCollapsed] = usePersistedState<string[]>('chromatrix.sessions.collapsed', [], (v) =>
    Array.isArray(v),
  )
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

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setFailure(undefined)
    try {
      await fn()
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(undefined)
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

      {error && <Banner>{`Gateway unreachable — ${error}`}</Banner>}
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
                busy={busy === `tab:${s.identity}`}
                onTakeover={(targetId) => goTakeover(s.identity, targetId)}
                onHealth={() =>
                  void run(`health:${s.identity}`, async () => {
                    const h = await gateway.health(s.identity)
                    flash(`${s.identity}: ${h.product}`)
                  })
                }
                onStop={() =>
                  void run(`stop:${s.identity}`, async () => {
                    await gateway.stopIdentity(s.identity)
                    flash(`Stopped “${s.identity}”.`)
                  })
                }
                onAllocate={(agentId, url) =>
                  void run(`tab:${s.identity}`, async () => {
                    // Size precedence lives on the gateway (explicit → global default → Chrome's own). The
                    // dashboard only supplies the fit-the-takeover-pane size, and only when no global default
                    // exists — otherwise it would silently outrank the user's setting.
                    await gateway.allocateTab(
                      s.identity,
                      agentId,
                      url,
                      settings?.defaultViewport ? undefined : fitTakeoverViewport(),
                    )
                  })
                }
                onRelease={(targetId) =>
                  void run(`release:${s.identity}`, async () => {
                    await gateway.releaseTab(s.identity, targetId)
                  })
                }
              />
            ))}
            <StartIdentityRow
              busy={busy === 'start'}
              onStart={(id, headless) =>
                run('start', async () => {
                  await gateway.createIdentity(id)
                  await gateway.startIdentity(id, headless)
                  flash(`Started “${id}”.`)
                })
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A failure that stays put. Transient confirmations are toasts (see Sonner); this is only for things the user
 * needs to still be able to read a minute later — a mutation that failed, or a gateway we can't reach.
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
 * The last row of the session list: start a new identity. Deliberately shaped like the "New tab" placeholder
 * card one level down — the next empty slot in the list you're already reading, rather than a separate form
 * above it. Starting an identity is a two-call sequence (create, then start); that's the gateway's business,
 * so here it is one button.
 */
function StartIdentityRow({
  busy,
  onStart,
}: {
  busy: boolean
  onStart: (id: string, headless: boolean) => void
}) {
  const [id, setId] = React.useState('')
  const [headless, setHeadless] = React.useState(true)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = id.trim()
        if (!trimmed || busy) return
        onStart(trimmed, headless)
        setId('')
      }}
      className='flex flex-wrap items-center gap-2 bg-bg px-3 py-2.5'>
      <Plus className='size-4 shrink-0 text-fg-4' aria-hidden />
      <Input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder='new identity id — lowercase slug, e.g. acme-1'
        className='min-w-56 flex-1 font-mono'
        aria-label='New identity id'
      />
      <label className='flex shrink-0 select-none items-center gap-2 text-body-sm text-fg-2'>
        <input
          type='checkbox'
          checked={headless}
          onChange={(e) => setHeadless(e.target.checked)}
          className='size-4 accent-[var(--accent)]'
        />
        headless
      </label>
      <Button type='submit' disabled={busy || !id.trim()}>
        <Play />
        {busy ? 'Starting…' : 'Start session'}
      </Button>
    </form>
  )
}
