import { MIN_VIEWPORT_HEIGHT, MIN_VIEWPORT_WIDTH, type Viewport } from './types'
import { readStored, writeStored } from './usePersistedState'

const AREA_KEY = 'chromatrix.takeoverArea'

/**
 * Shell dimensions the estimate depends on. Kept here (rather than inline in the estimate) so that changing
 * the chrome means changing one number in one place — an estimate that silently drifts from the real layout
 * is worse than no estimate, because it looks authoritative.
 */
const SIDEBAR_W = 248 // Sidebar.tsx: w-[248px]
const TOPBAR_H = 56 // TopBar.tsx: h-14
const TAKEOVER_BAR_H = 45 // TakeoverView toolbar: py-2 around h-7 controls
const PANE_PADDING = 32 // TakeoverView pane: p-4 on both axes

export function clampViewport(v: Viewport): Viewport {
  return {
    width: Math.max(MIN_VIEWPORT_WIDTH, Math.round(v.width)),
    height: Math.max(MIN_VIEWPORT_HEIGHT, Math.round(v.height)),
  }
}

/** Record the takeover pane's real measured size, so later estimates are exact rather than derived. */
export function rememberTakeoverArea(area: Viewport): void {
  writeStored(AREA_KEY, clampViewport(area))
}

/**
 * The viewport a new tab should get so it exactly fills the takeover pane.
 *
 * Prefers a real measurement recorded the last time the takeover view was open. Falls back to deriving one
 * from the current window and the shell constants above — needed because a tab can be created from Sessions,
 * where the takeover pane isn't mounted and therefore can't be measured. The fallback self-corrects the first
 * time takeover is opened at this window size.
 */
export function fitTakeoverViewport(): Viewport {
  const measured = readStored<Viewport | null>(AREA_KEY, null, (v) => {
    const c = v as Viewport | null
    return !!c && typeof c.width === 'number' && typeof c.height === 'number'
  })
  if (measured) return clampViewport(measured)

  const sidebar = window.innerWidth >= 768 ? SIDEBAR_W : 0
  return clampViewport({
    width: window.innerWidth - sidebar - PANE_PADDING,
    height: window.innerHeight - TOPBAR_H - TAKEOVER_BAR_H - PANE_PADDING,
  })
}
