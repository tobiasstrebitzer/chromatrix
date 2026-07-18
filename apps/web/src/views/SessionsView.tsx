import * as React from 'react'
import { Activity, Check, Copy, Play, Plus, Square, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { gateway } from '@/lib/useGateway'
import { useSessionsContext } from '@/lib/sessionsContext'
import type { AllocatedTab, SessionInfo } from '@/lib/types'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'

// Sessions dashboard — the provisioning surface as a UI. Start an identity (a real headed Chrome), then per
// running identity lease exclusive tabs for named agents; each lease hands back the scoped, single-use CDP
// URL an agent connects to. Mirrors the gateway's tRPC actions (see lib/useGateway.ts).
export function SessionsView() {
  const { sessions, error, refresh } = useSessionsContext()
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  // Leased tabs are tracked client-side (the gateway lists sessions, not per-tab detail) so we can show the
  // scoped URL to copy and offer a release control.
  const [tabsByIdentity, setTabsByIdentity] = React.useState<Record<string, AllocatedTab[]>>({})

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(undefined), 3500)
  }
  const fail = (e: unknown) => flash((e as Error).message)

  const onAllocated = (tab: AllocatedTab) =>
    setTabsByIdentity((m) => ({ ...m, [tab.identity]: [...(m[tab.identity] ?? []), tab] }))
  const onReleased = (identity: string, targetId: string) =>
    setTabsByIdentity((m) => ({ ...m, [identity]: (m[identity] ?? []).filter((t) => t.targetId !== targetId) }))
  const onStopped = (identity: string) =>
    setTabsByIdentity((m) => {
      const { [identity]: _drop, ...rest } = m
      return rest
    })

  return (
    <div className='mx-auto w-full max-w-5xl px-6 py-6'>
      <header className='mb-5'>
        <h1 className='text-display-sm font-semibold text-text'>Sessions</h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>
          One real headed Chrome per identity. Start one, then lease exclusive tabs for your agents.
        </p>
      </header>

      {(notice || error) && (
        <div className='mb-4 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-body-sm text-danger'>
          {notice ?? `Gateway unreachable: ${error}`}
        </div>
      )}

      <StartIdentityForm onDone={refresh} onError={fail} onNotice={flash} />

      <div className='mt-6'>
        {sessions === undefined ? (
          <p className='text-body-sm text-muted-foreground'>Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <EmptyState />
        ) : (
          <div className='grid gap-4 md:grid-cols-2'>
            {sessions.map((s) => (
              <SessionCard
                key={s.identity}
                session={s}
                tabs={tabsByIdentity[s.identity] ?? []}
                onAllocated={onAllocated}
                onReleased={onReleased}
                onStopped={onStopped}
                onNotice={flash}
                onError={fail}
                afterMutate={refresh}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StartIdentityForm({
  onDone,
  onError,
  onNotice,
}: {
  onDone: () => Promise<void>
  onError: (e: unknown) => void
  onNotice: (msg: string) => void
}) {
  const [id, setId] = React.useState('')
  const [headless, setHeadless] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = id.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await gateway.createIdentity(trimmed)
      await gateway.startIdentity(trimmed, headless)
      onNotice(`Started “${trimmed}”.`)
      setId('')
      await onDone()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardContent className='pt-4'>
        <form onSubmit={submit} className='flex flex-wrap items-center gap-3'>
          <div className='min-w-52 flex-1'>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder='identity id  (lowercase slug, e.g. acme-1)'
              className='font-mono'
              aria-label='Identity id'
            />
          </div>
          <label className='flex select-none items-center gap-2 text-body-sm text-fg-2'>
            <input type='checkbox' checked={headless} onChange={(e) => setHeadless(e.target.checked)} className='size-4 accent-accent' />
            headless
          </label>
          <Button type='submit' disabled={busy || !id.trim()}>
            <Play />
            {busy ? 'Starting…' : 'Start identity'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function SessionCard({
  session,
  tabs,
  onAllocated,
  onReleased,
  onStopped,
  onNotice,
  onError,
  afterMutate,
}: {
  session: SessionInfo
  tabs: AllocatedTab[]
  onAllocated: (t: AllocatedTab) => void
  onReleased: (identity: string, targetId: string) => void
  onStopped: (identity: string) => void
  onNotice: (msg: string) => void
  onError: (e: unknown) => void
  afterMutate: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [agentId, setAgentId] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const allocate = async (e: React.FormEvent) => {
    e.preventDefault()
    const agent = agentId.trim() || 'agent-1'
    if (busy) return
    setBusy(true)
    try {
      const tab = await gateway.allocateTab(session.identity, agent)
      onAllocated(tab)
      await afterMutate()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  const release = async (targetId: string) => {
    try {
      await gateway.releaseTab(session.identity, targetId)
      onReleased(session.identity, targetId)
      await afterMutate()
    } catch (e) {
      onError(e)
    }
  }

  const stop = async () => {
    try {
      await gateway.stopIdentity(session.identity)
      onStopped(session.identity)
      onNotice(`Stopped “${session.identity}”.`)
      await afterMutate()
    } catch (e) {
      onError(e)
    }
  }

  const health = async () => {
    try {
      const h = await gateway.health(session.identity)
      onNotice(`${session.identity}: ${h.product}`)
    } catch (e) {
      onError(e)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className='min-w-0'>
          <CardTitle className='flex items-center gap-2 font-mono'>
            <span className='size-2 rounded-full' style={{ background: 'var(--chroma-gradient)' }} />
            <span className='truncate'>{session.identity}</span>
          </CardTitle>
          <p className='mt-1 truncate text-label text-muted-foreground' title={session.profileDir}>
            {session.profileDir}
          </p>
        </div>
        <StateBadge state={session.state} />
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='flex items-center gap-2 text-label text-muted-foreground'>
          <span>{session.tabs} leased tab{session.tabs === 1 ? '' : 's'}</span>
          <span className='text-border-strong'>·</span>
          <span className='truncate font-mono' title={session.browserWsUrl}>
            {session.browserWsUrl.replace(/^ws:\/\//, '')}
          </span>
        </div>

        {tabs.length > 0 && (
          <ul className='space-y-1.5'>
            {tabs.map((t) => (
              <li key={t.targetId} className='rounded-md border border-border bg-bg px-2.5 py-1.5'>
                <div className='flex items-center gap-2'>
                  <Badge variant='accent' mono>{t.agentId}</Badge>
                  <span className='truncate font-mono text-label text-muted-foreground' title={t.targetId}>
                    {t.targetId.slice(0, 12)}
                  </span>
                  <div className='ml-auto flex items-center gap-1'>
                    <CopyButton value={t.cdpUrl} />
                    <Button variant='ghost' size='icon-sm' aria-label='Release tab' title='Release tab' onClick={() => release(t.targetId)}>
                      <X />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={allocate} className='flex items-center gap-2'>
          <Input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder='agent id'
            className='h-8 font-mono'
            aria-label='Agent id'
          />
          <Button type='submit' variant='secondary' size='sm' disabled={busy}>
            <Plus />
            {busy ? '…' : 'Tab'}
          </Button>
        </form>

        <div className='flex items-center gap-1.5 border-t border-border pt-3'>
          <Button variant='outline' size='sm' onClick={() => void navigate({ to: '/takeover/$identity', params: { identity: session.identity } })}>
            Takeover
          </Button>
          <Button variant='ghost' size='sm' onClick={health}>
            <Activity />
            Health
          </Button>
          <Button variant='destructive' size='sm' className='ml-auto' onClick={stop}>
            <Square />
            Stop
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function StateBadge({ state }: { state: string }) {
  if (state === 'running') return <Badge variant='success' dot>running</Badge>
  if (state === 'starting') return <Badge variant='warning' dot>starting</Badge>
  return <Badge variant='neutral' dot>{state}</Badge>
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      variant='ghost'
      size='icon-sm'
      aria-label='Copy scoped CDP URL'
      title='Copy scoped CDP URL'
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}>
      {copied ? <Check className='text-success' /> : <Copy />}
    </Button>
  )
}

function EmptyState() {
  return (
    <div className='rounded-lg border border-dashed border-border-light bg-surface px-6 py-12 text-center'>
      <p className='text-body-sm text-muted-foreground'>No running sessions. Start an identity above to launch its Chrome.</p>
    </div>
  )
}
