import * as React from 'react'

/**
 * localStorage-backed React state. Safe when storage is unavailable (falls back to the in-memory
 * default). Values are JSON-serialized; an optional `valid` guard rejects malformed/stale stored values.
 */
export function readStored<T>(key: string, fallback: T, valid?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (valid && !valid(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}

export function writeStored<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore persistence failures */
  }
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  valid?: (v: unknown) => boolean,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = React.useState<T>(() => readStored(key, fallback, valid))
  React.useEffect(() => {
    writeStored(key, state)
  }, [key, state])
  return [state, setState]
}
