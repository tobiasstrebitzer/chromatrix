import * as React from 'react'

/**
 * A counter that advances every `intervalMs` — the cache-buster behind the tab thumbnails.
 *
 * Ticks are suppressed while the document is hidden. Each tick costs one `Page.captureScreenshot` per visible
 * tab, and a dashboard left open on a background monitor would otherwise drive real CDP traffic into every
 * identity's Chrome forever for nobody's benefit.
 */
export function usePollTick(intervalMs: number, enabled = true): number {
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1)
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, enabled])

  return tick
}
