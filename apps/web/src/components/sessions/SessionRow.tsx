import { Activity, ChevronRight, Loader2, MonitorPlay, Play, Power, Trash2 } from 'lucide-react'
import type { AllocatedTab, SessionInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { NewTabCard, TabCard } from './TabCard'

/** The next unused `agent-N` for this identity, so repeated "new tab" clicks don't all land on agent-1. */
function nextAgentId(tabs: AllocatedTab[]): string {
  const taken = new Set(tabs.map((t) => t.agentId))
  for (let n = 1; ; n++) {
    const candidate = `agent-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function StateBadge({ state }: { state: SessionInfo['state'] }) {
  if (state === 'running')
    return (
      <Badge variant='success' dot>
        running
      </Badge>
    )
  if (state === 'starting')
    return (
      <Badge variant='warning' dot>
        starting
      </Badge>
    )
  return (
    <Badge variant='neutral' dot>
      {state}
    </Badge>
  )
}

export interface SessionRowProps {
  session: SessionInfo
  expanded: boolean
  onToggle: () => void
  /** Advances every poll interval; drives the tab thumbnails. */
  tick: number
  /**
   * In-flight action keys from SessionsView's `run` - `start:<id>`, `stop:<id>`, `health:<id>`,
   * `delete:<id>`, `tab:<id>`, `release:<id>:<targetId>` - so each control shows its own busy state
   * instead of one action greying out the whole page.
   */
  busy: ReadonlySet<string>
  onTakeover: (targetId?: string) => void
  onHealth: () => void
  onStart: () => void
  /** Launch option, remembered by the dashboard - see SessionsView. Only offered where a start is offered. */
  headless: boolean
  onHeadlessChange: (headless: boolean) => void
  onStop: () => void
  /** Opens the type-to-confirm dialog; the row itself never deletes directly. */
  onDelete: () => void
  onAllocate: (agentId: string, url?: string) => void
  onRelease: (targetId: string) => void
}

/**
 * One identity as a full-width row: a header you can act on without expanding, and - when expanded - its
 * tabs as a grid of live cards.
 *
 * Rows rather than cards because an identity is a *heading*, not a peer of its tabs: the old two-column card
 * grid gave a session and a tab the same visual weight and left no room to show what a tab was actually
 * doing. Collapsing is per-identity so a fleet of ten sessions stays scannable.
 */
export function SessionRow({
  session,
  expanded,
  onToggle,
  tick,
  busy,
  onTakeover,
  onHealth,
  onStart,
  headless,
  onHeadlessChange,
  onStop,
  onDelete,
  onAllocate,
  onRelease,
}: SessionRowProps) {
  const tabs = session.leases
  const suggested = nextAgentId(tabs)
  const bodyId = `session-body-${session.identity}`
  const running = session.state === 'running'
  const busyOn = (action: string) => busy.has(`${action}:${session.identity}`)
  const starting = busyOn('start') || session.state === 'starting'
  const stopping = busyOn('stop')

  return (
    <div>
      <div className='flex items-center gap-3 px-3 py-2.5'>
        <button
          type='button'
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className='flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring'>
          <ChevronRight
            className={cn('size-4 shrink-0 text-fg-4 transition-transform', expanded && 'rotate-90')}
            aria-hidden
          />
          <span className='truncate font-mono text-body-sm font-medium text-fg-1'>{session.identity}</span>
          <StateBadge state={session.state} />
          <span className='hidden truncate text-label text-fg-4 sm:inline'>
            {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
          </span>
        </button>

        {/* Start/Stop is one slot that swaps by state, not two buttons where one is always dead: a stopped
            session can only be started and a running one can only be stopped, so showing both would mean
            permanently greying out half the control. Delete sits apart and is always available - a session you
            no longer want is one you should be able to discard without starting it first. */}
        <div className='flex shrink-0 items-center gap-1'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => onTakeover()}
            disabled={!running}
            title={running ? 'Open live view' : 'Start the session to take it over'}>
            <MonitorPlay />
            <span className='hidden sm:inline'>Takeover</span>
          </Button>
          <Button
            variant='ghost'
            size='icon-sm'
            onClick={onHealth}
            disabled={!running || busyOn('health')}
            aria-label='Check health'
            title={running ? 'Check health' : 'Start the session to check its health'}>
            {busyOn('health') ? <Loader2 className='animate-spin' /> : <Activity />}
          </Button>
          {running ? (
            <Button
              variant='ghost'
              size='icon-sm'
              onClick={onStop}
              disabled={stopping}
              aria-label='Stop session'
              title='Stop session'>
              {stopping ? <Loader2 className='animate-spin' /> : <Power />}
            </Button>
          ) : (
            <Button
              variant='ghost'
              size='icon-sm'
              onClick={onStart}
              disabled={starting}
              aria-label='Start session'
              title='Start session'>
              {starting ? <Loader2 className='animate-spin' /> : <Play />}
            </Button>
          )}
          <Button
            variant='destructive'
            size='icon-sm'
            onClick={onDelete}
            disabled={busyOn('delete')}
            aria-label='Delete session'
            title='Delete session'>
            {busyOn('delete') ? <Loader2 className='animate-spin' /> : <Trash2 />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div id={bodyId} className='border-t border-border bg-bg px-3 py-3'>
          <p className='mb-2.5 truncate font-mono text-label text-fg-4' title={session.profileDir}>
            {session.profileDir}
          </p>
          {/* A stopped session has no Chrome, so there are no tabs to show and none to lease. Say so and offer
              the one action that leads anywhere, rather than rendering an empty grid with a dead new-tab form
              that would fail on submit. */}
          {running ? (
            /* items-start: the new-tab card carries a form and is legitimately taller than a tab card. Left to
               stretch, every real card would inherit that height and gain a band of dead space under its
               footer. Tab cards are uniform among themselves (single-line truncated titles), so they still
               line up. */
            <div className='grid items-start gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
              {tabs.map((t) => (
                <TabCard
                  key={t.targetId}
                  tab={t}
                  tick={tick}
                  releasing={busy.has(`release:${session.identity}:${t.targetId}`)}
                  onOpen={() => onTakeover(t.targetId)}
                  onRelease={() => onRelease(t.targetId)}
                />
              ))}
              <NewTabCard suggestedAgentId={suggested} busy={busyOn('tab')} onCreate={onAllocate} />
            </div>
          ) : (
            <div className='flex flex-col items-center gap-2.5 rounded-md border border-dashed border-border px-6 py-8 text-center'>
              <p className='text-body-sm text-muted-foreground'>
                This session is stopped. Its profile is kept on disk - start it to resume where it left off.
              </p>
              <div className='flex flex-wrap items-center justify-center gap-3'>
                <Button size='sm' onClick={onStart} disabled={starting}>
                  {starting ? <Loader2 className='animate-spin' /> : <Play />}
                  {starting ? 'Starting…' : 'Start session'}
                </Button>
                <label className='flex select-none items-center gap-2 text-body-sm text-fg-2'>
                  <input
                    type='checkbox'
                    checked={headless}
                    onChange={(e) => onHeadlessChange(e.target.checked)}
                    className='size-4 accent-[var(--accent)]'
                  />
                  headless
                </label>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
