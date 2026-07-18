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

/**
 * Automation-hygiene flags. Proven in spike S2: a plain `--remote-debugging-port` launch leaks
 * `navigator.webdriver = true` via the AutomationControlled blink feature; this flag flips it to false.
 * We deliberately do NOT pass `--enable-automation` (it adds the "controlled by automation" infobar and
 * further tells). See docs/PRD.md §7 (S2) and spikes/s2-stealth-baseline/README.md.
 */
export const AUTOMATION_HIDE_FLAGS = ['--disable-blink-features=AutomationControlled'] as const

/** All stealth launch flags to apply to a headed identity Chrome (order-independent). */
export const STEALTH_LAUNCH_FLAGS = [...ANTI_BACKGROUNDING_FLAGS, ...AUTOMATION_HIDE_FLAGS] as const

export const STEALTH_PACKAGE = '@chromatrix/stealth' as const
