import { MIN_VIEWPORT_HEIGHT, MIN_VIEWPORT_WIDTH, type Viewport } from './types'
import { readStored, writeStored } from './usePersistedState'

const AREA_KEY = 'chromatrix.takeoverArea'

/**
 * Shell dimensions the fallback estimate depends on. Kept here (rather than inline) so that changing the
 * chrome means changing one number in one place - an estimate that silently drifts from the real layout is
 * worse than no estimate, because it looks authoritative.
 *
 * These are **measured**, not read off the utility classes, because two of them are easy to get wrong: the top
 * bar's `h-14` is 56 but it also carries a `border-b`, and `.frame-shine` has a 1px *transparent* border on
 * all four sides that is invisible in the markup. With these values the estimate reproduces the measured pane
 * exactly (verified at 1800×987: 1542×867 both ways).
 */
const SIDEBAR_W = 248 // Sidebar.tsx: w-[248px]
const TOPBAR_H = 57 // TopBar.tsx: h-14 (56) + border-b
const TAKEOVER_BAR_H = 45 // TakeoverView toolbar: py-2 around h-7 controls + border-b
const FRAME_GUTTER = 8 // AppShell: p-2 around the inset panel
const FRAME_BORDER = 1 // .frame-shine: a transparent 1px border carrying the gradient edge

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
 * from the current window and the shell constants above - needed because a tab can be created from Sessions,
 * where the takeover pane isn't mounted and therefore can't be measured. The fallback self-corrects the first
 * time takeover is opened at this window size.
 */
export function fitTakeoverViewport(): Viewport {
  const measured = readStored<Viewport | null>(AREA_KEY, null, (v) => {
    const c = v as Viewport | null
    return !!c && typeof c.width === 'number' && typeof c.height === 'number'
  })
  if (measured) return clampViewport(measured)

  // The stage is unpadded, so the only space lost is the shell itself: the nav, the panel's gutter and border,
  // and the two bars above the stage. `md:pl-0` drops the left gutter once the rail is there, so the wide
  // layout loses one horizontal gutter and the narrow one loses two; the border is always on both sides.
  const wide = window.innerWidth >= 768
  const gutterX = wide ? SIDEBAR_W + FRAME_GUTTER : FRAME_GUTTER * 2
  return clampViewport({
    width: window.innerWidth - gutterX - FRAME_BORDER * 2,
    height: window.innerHeight - FRAME_GUTTER * 2 - FRAME_BORDER * 2 - TOPBAR_H - TAKEOVER_BAR_H,
  })
}
