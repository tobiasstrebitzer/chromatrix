import * as React from 'react'
import { gateway } from '@/lib/useGateway'
import { clampViewport, fitTakeoverViewport } from '@/lib/viewportFit'
import { MIN_VIEWPORT_HEIGHT, MIN_VIEWPORT_WIDTH, type GatewaySettings } from '@/lib/types'
import { toast } from '@/components/ui/Sonner'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

/**
 * Gateway-wide settings. Small on purpose - this exists because the default viewport has to apply to tabs
 * created by *agents over MCP* too, which means it belongs on the server, not in this app's local storage.
 */
export function SettingsView() {
  const [settings, setSettings] = React.useState<GatewaySettings | undefined>(undefined)
  const [draft, setDraft] = React.useState({ width: '', height: '' })
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    const s = await gateway.getSettings()
    setSettings(s)
    setDraft({
      width: s.defaultViewport ? String(s.defaultViewport.width) : '',
      height: s.defaultViewport ? String(s.defaultViewport.height) : '',
    })
  }, [])

  React.useEffect(() => {
    void load().catch((e: unknown) =>
      toast.error('Could not load settings', { description: e instanceof Error ? e.message : String(e) }),
    )
  }, [load])

  const save = async (v: { width: number; height: number }) => {
    setBusy(true)
    try {
      const s = await gateway.setDefaultViewport(v.width, v.height)
      setSettings(s)
      setDraft({
        width: s.defaultViewport ? String(s.defaultViewport.width) : '',
        height: s.defaultViewport ? String(s.defaultViewport.height) : '',
      })
      toast(
        s.defaultViewport
          ? `Default viewport set to ${s.defaultViewport.width}×${s.defaultViewport.height}`
          : 'Default cleared - new tabs will fit the takeover viewer',
      )
    } catch (e) {
      toast.error('Could not save settings', {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='mx-auto w-full max-w-3xl px-6 py-6'>
      <header className='mb-4'>
        <h1 className='text-display-sm font-semibold tracking-tight text-text'>Settings</h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>Gateway-wide defaults, shared by the dashboard and agents.</p>
      </header>

      <section className='rounded-lg border border-border bg-surface p-4'>
        <h2 className='text-body font-medium text-fg-1'>Default viewport</h2>
        <p className='mt-1 max-w-prose text-body-sm text-muted-foreground'>
          Applied to every new tab that doesn't request its own size. Each tab gets its own browser window, so
          this is a per-tab size, not a per-session one. Leave it blank and the dashboard will instead size new
          tabs to fill the takeover viewer exactly.
        </p>

        <form
          className='mt-3 flex flex-wrap items-center gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            const w = Number(draft.width)
            const h = Number(draft.height)
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
            void save(clampViewport({ width: w, height: h }))
          }}>
          <Input
            value={draft.width}
            onChange={(e) => setDraft((d) => ({ ...d, width: e.target.value }))}
            placeholder='width'
            inputMode='numeric'
            aria-label='Default viewport width'
            className='w-24 text-center font-mono'
          />
          <span className='text-fg-4' aria-hidden>
            ×
          </span>
          <Input
            value={draft.height}
            onChange={(e) => setDraft((d) => ({ ...d, height: e.target.value }))}
            placeholder='height'
            inputMode='numeric'
            aria-label='Default viewport height'
            className='w-24 text-center font-mono'
          />
          <Button type='submit' disabled={busy}>
            Save
          </Button>
          <Button
            type='button'
            variant='outline'
            disabled={busy}
            onClick={() => {
              const fit = fitTakeoverViewport()
              setDraft({ width: String(fit.width), height: String(fit.height) })
            }}>
            Use viewer size
          </Button>
          <Button type='button' variant='ghost' disabled={busy || !settings?.defaultViewport} onClick={() => void save({ width: 0, height: 0 })}>
            Clear
          </Button>
        </form>

        <p className='mt-2 text-label text-fg-4'>
          Minimum {MIN_VIEWPORT_WIDTH}×{MIN_VIEWPORT_HEIGHT} - Chrome refuses to make a window smaller, so
          phone-width viewports aren't reachable without emulation overrides (which this project avoids).
        </p>
      </section>
    </div>
  )
}
