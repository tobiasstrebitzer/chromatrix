import * as React from 'react'

/**
 * Global "something is happening" signal, driving the logo's activity mode.
 *
 * A plain counter in module scope rather than context: activity is reported from the gateway façade (which
 * isn't a component) and read by one glyph in the shell, so threading a provider between them would be all
 * cost and no benefit.
 */

/**
 * Floor on how long activity stays visible. Most mutations here resolve in tens of milliseconds, and a spinner
 * that appears and vanishes within one frame reads as a glitch rather than as feedback.
 */
const MIN_VISIBLE_MS = 450

let inFlight = 0
let visibleUntil = 0
let holdTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

const emit = () => {
  for (const l of listeners) l()
}

const isBusy = () => inFlight > 0 || Date.now() < visibleUntil

/** Count a promise as activity for as long as it is pending. Returns it unchanged, so it can wrap inline. */
export function trackActivity<T>(promise: Promise<T>): Promise<T> {
  if (inFlight === 0) visibleUntil = Date.now() + MIN_VISIBLE_MS
  inFlight += 1
  emit()

  return promise.finally(() => {
    inFlight -= 1
    if (inFlight > 0) {
      emit()
      return
    }
    // Last one out: hold the signal until the floor elapses, then tell subscribers it's over.
    const remaining = visibleUntil - Date.now()
    if (remaining <= 0) {
      emit()
      return
    }
    clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      if (inFlight === 0) emit()
    }, remaining)
    emit()
  })
}

export function useIsBusy(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    isBusy,
    () => false,
  )
}
