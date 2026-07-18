/**
 * Theme module — light/dark only. On first launch (nothing persisted) the theme is seeded from the OS
 * preference and stored, so the toggle always has a definite state. Switching flips a single `data-theme`
 * attribute on <html>; the only persisted state is the pref in localStorage["chromatrix.theme"].
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'chromatrix.theme'
const VALID: ReadonlySet<string> = new Set(['light', 'dark'])

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

/** Read the stored theme; on first launch seed from the OS preference and persist it. */
export function getTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && VALID.has(raw)) return raw as Theme
  } catch {
    /* storage unavailable → fall through to OS default */
  }
  const initial: Theme = prefersDark() ? 'dark' : 'light'
  try {
    localStorage.setItem(STORAGE_KEY, initial)
  } catch {
    /* ignore persistence failures */
  }
  return initial
}

/** Apply a theme to <html data-theme>. Pure DOM write, no re-render. */
export function applyTheme(theme: Theme = getTheme()): Theme {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  return theme
}

/** Persist + apply a theme preference. */
export function setTheme(theme: Theme): Theme {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* ignore persistence failures */
  }
  return applyTheme(theme)
}

/** Flip light↔dark, persist, and apply. Returns the new theme. */
export function toggleTheme(current: Theme): Theme {
  return setTheme(current === 'dark' ? 'light' : 'dark')
}
