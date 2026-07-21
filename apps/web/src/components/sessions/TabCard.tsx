import * as React from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { tabScreenshotUrl } from '@/lib/useGateway'
import type { AllocatedTab } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { BlankTab } from '@/components/ui/BlankTab'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Input } from '@/components/ui/Input'

/** Every card - real or placeholder - is the same box, so the grid never reflows as tabs come and go. */
const CARD = 'flex flex-col overflow-hidden rounded-md border border-border bg-surface'
const THUMB = 'relative aspect-16/10 w-full overflow-hidden bg-bg'

/** A tab that has never navigated. Chrome reports `about:blank`; an empty string is a target mid-creation. */
function isBlank(url?: string): boolean {
  return !url || url === 'about:blank'
}

function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Live thumbnail of one tab, refreshed whenever `tick` advances.
 *
 * The new frame is decoded into a detached `Image` first and only swapped in on load. Pointing the visible
 * `<img>` straight at the new URL would blank it for the duration of every fetch, which at a 5s cadence is a
 * visible strobe across the whole grid. On error the last good frame stays up (dimmed) rather than
 * collapsing to a placeholder - a single failed capture is usually a transient mid-navigation blip, not a
 * dead tab.
 */
function Thumbnail({ identity, targetId, tick }: { identity: string; targetId: string; tick: number }) {
  const [src, setSrc] = React.useState<string | null>(null)
  const [stale, setStale] = React.useState(false)

  React.useEffect(() => {
    const next = tabScreenshotUrl(identity, targetId, tick)
    const probe = new Image()
    let cancelled = false
    probe.onload = () => {
      if (cancelled) return
      setSrc(next)
      setStale(false)
    }
    probe.onerror = () => {
      if (!cancelled) setStale(true)
    }
    probe.src = next
    return () => {
      cancelled = true
      probe.onload = null
      probe.onerror = null
    }
  }, [identity, targetId, tick])

  if (!src) {
    return (
      <div className='absolute inset-0 grid place-items-center'>
        <span className='text-label text-fg-4'>{stale ? 'No preview' : 'Loading preview…'}</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt=''
      draggable={false}
      className={cn('absolute inset-0 size-full object-cover object-top transition-opacity', stale && 'opacity-40')}
    />
  )
}

export function TabCard({
  tab,
  tick,
  releasing,
  onOpen,
  onRelease,
}: {
  tab: AllocatedTab
  tick: number
  /** This tab's own release is in flight - spins its button without freezing the rest of the grid. */
  releasing?: boolean
  onOpen: () => void
  onRelease: () => void
}) {
  const blank = isBlank(tab.url)
  // A blank tab's CDP title is the literal string "about:blank", which is noise rather than a name - the
  // thumbnail already says what's going on, so the footer just needs to not contradict it.
  const label = blank ? 'Untitled tab' : tab.title?.trim() || hostOf(tab.url) || 'Untitled'

  return (
    <div className={CARD}>
      <button
        type='button'
        onClick={onOpen}
        title={blank ? 'Take over this tab' : `Take over - ${tab.url}`}
        className={cn(
          THUMB,
          'group block cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        )}>
        {blank ? (
          <BlankTab size='sm' className='absolute inset-0' />
        ) : (
          <Thumbnail identity={tab.identity} targetId={tab.targetId} tick={tick} />
        )}
        {/* Hover scrim: the affordance that a thumbnail is a door to the takeover view, not just a picture. */}
        <span className='absolute inset-0 grid place-items-center bg-bg/70 opacity-0 transition-opacity group-hover:opacity-100'>
          <span className='rounded-md border border-border bg-surface px-2 py-1 text-label font-medium text-fg-1'>
            Take over
          </span>
        </span>
      </button>

      <div className='flex min-w-0 items-center gap-2 border-t border-border px-2.5 py-2'>
        <div className='min-w-0 flex-1'>
          <p className={cn('truncate text-body-sm font-medium', blank ? 'text-fg-3' : 'text-fg-1')} title={tab.url}>
            {label}
          </p>
          <Badge variant='neutral' mono className='mt-1'>
            {tab.agentId}
          </Badge>
        </div>
        <div className='flex shrink-0 items-center'>
          <CopyButton value={tab.cdpUrl} label='Copy scoped CDP URL' />
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='Release tab'
            title='Release tab'
            disabled={releasing}
            onClick={onRelease}>
            {releasing ? <Loader2 className='animate-spin' /> : <X />}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The "new tab" affordance, shaped exactly like a real tab card so it reads as the next slot in the grid
 * rather than as a form bolted underneath it.
 */
export function NewTabCard({
  suggestedAgentId,
  busy,
  onCreate,
}: {
  suggestedAgentId: string
  busy: boolean
  onCreate: (agentId: string, url?: string) => void
}) {
  const [agentId, setAgentId] = React.useState('')
  const [url, setUrl] = React.useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    onCreate(agentId.trim() || suggestedAgentId, url.trim() || undefined)
    setAgentId('')
    setUrl('')
  }

  return (
    <form
      onSubmit={submit}
      className={cn(CARD, 'border-dashed bg-transparent transition-colors hover:border-border-strong')}>
      <div className={cn(THUMB, 'grid place-items-center bg-transparent')}>
        <div className='text-center'>
          <Plus className='mx-auto mb-1.5 size-5 text-fg-4' />
          <p className='text-body-sm font-medium text-fg-2'>New tab</p>
          <p className='mt-0.5 text-label text-fg-4'>leased exclusively to one agent</p>
        </div>
      </div>
      <div className='space-y-1.5 border-t border-dashed border-border px-2.5 py-2'>
        <Input
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder={suggestedAgentId}
          className='h-7 font-mono text-label'
          aria-label='Agent id'
        />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder='start url (optional)'
          className='h-7 font-mono text-label'
          aria-label='Start URL'
        />
        <Button type='submit' size='sm' className='w-full' disabled={busy}>
          {busy ? 'Creating…' : 'Create tab'}
        </Button>
      </div>
    </form>
  )
}
