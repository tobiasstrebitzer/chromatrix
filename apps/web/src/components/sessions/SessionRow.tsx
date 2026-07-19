import { Activity, ChevronRight, MonitorPlay, Power } from 'lucide-react'
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

function StateBadge({ state }: { state: string }) {
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
  busy: boolean
  onTakeover: (targetId?: string) => void
  onHealth: () => void
  onStop: () => void
  onAllocate: (agentId: string, url?: string) => void
  onRelease: (targetId: string) => void
}

/**
 * One identity as a full-width row: a header you can act on without expanding, and — when expanded — its
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
  onStop,
  onAllocate,
  onRelease,
}: SessionRowProps) {
  const tabs = session.leases
  const suggested = nextAgentId(tabs)
  const bodyId = `session-body-${session.identity}`

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

        <div className='flex shrink-0 items-center gap-1'>
          <Button variant='outline' size='sm' onClick={() => onTakeover()}>
            <MonitorPlay />
            <span className='hidden sm:inline'>Takeover</span>
          </Button>
          <Button variant='ghost' size='icon-sm' onClick={onHealth} aria-label='Check health' title='Check health'>
            <Activity />
          </Button>
          <Button variant='destructive' size='icon-sm' onClick={onStop} aria-label='Stop identity' title='Stop identity'>
            <Power />
          </Button>
        </div>
      </div>

      {expanded && (
        <div id={bodyId} className='border-t border-border bg-bg px-3 py-3'>
          <p className='mb-2.5 truncate font-mono text-label text-fg-4' title={session.profileDir}>
            {session.profileDir}
          </p>
          {/* items-start: the new-tab card carries a form and is legitimately taller than a tab card. Left to
              stretch, every real card would inherit that height and gain a band of dead space under its
              footer. Tab cards are uniform among themselves (single-line truncated titles), so they still
              line up. */}
          <div className='grid items-start gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {tabs.map((t) => (
              <TabCard
                key={t.targetId}
                tab={t}
                tick={tick}
                onOpen={() => onTakeover(t.targetId)}
                onRelease={() => onRelease(t.targetId)}
              />
            ))}
            <NewTabCard suggestedAgentId={suggested} busy={busy} onCreate={onAllocate} />
          </div>
        </div>
      )}
    </div>
  )
}
