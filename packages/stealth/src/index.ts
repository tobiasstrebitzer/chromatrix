// @chromatrix/stealth — launch flags, leak-mitigation policy, fingerprint hygiene, verification probes.
// See docs/PRD.md §4 (stealth layer) and §7 (spikes S1/S2). Populated once S1/S2 settle.

/**
 * Chrome launch flags that keep occluded/off-screen windows rendering (macOS throttles hidden windows
 * via WasHidden) and disable timer/renderer backgrounding. See docs/PRD.md §7 S2. Real `channel=chrome`
 * binary + an attached display/dummy-HDMI is what yields the authentic Apple/Metal WebGL fingerprint.
 */
export const ANTI_BACKGROUNDING_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
] as const

export const STEALTH_PACKAGE = '@chromatrix/stealth' as const
