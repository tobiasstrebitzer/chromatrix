// Chrome launch flags for chromatrix identities.

/**
 * Keep occluded/off-screen windows rendering (macOS throttles hidden windows via WasHidden) and disable
 * timer/renderer backgrounding. See docs/PRD.md §7 S2. Real `channel=chrome` + an attached display/dummy-HDMI
 * is what yields the authentic Apple/Metal WebGL fingerprint.
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
 * further tells). See docs/PRD.md §7 (S2); re-verify anytime with `pnpm fidelity:check`.
 */
export const AUTOMATION_HIDE_FLAGS = ['--disable-blink-features=AutomationControlled'] as const

/** All fidelity launch flags to apply to a headed identity Chrome (order-independent). */
export const FIDELITY_LAUNCH_FLAGS = [...ANTI_BACKGROUNDING_FLAGS, ...AUTOMATION_HIDE_FLAGS] as const
