// Dashboard authentication.
//
// The gateway takes ONE access token, and every surface accepts it as `Authorization: Bearer …`. A browser
// can't do that everywhere: `<img src>` (the tab-card screenshot poll) and `new WebSocket()` (takeover) have
// no way to set headers. So the dashboard trades the token for an HttpOnly cookie once, and every subsequent
// request — fetch, image, socket — carries it automatically because it is same-origin.
//
// Consequence worth knowing: the token is never held in JS, never in localStorage. The cookie is HttpOnly, so
// this module cannot read it back; `status()` asks the server instead of inspecting anything locally.

const AUTH_BASE = '/api/auth'

export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_BASE}/status`)
    if (!res.ok) return false
    return ((await res.json()) as { authenticated: boolean }).authenticated
  } catch {
    // A gateway that isn't answering is not the same as a rejected token, but the dashboard's only move is
    // the same either way: show the sign-in screen rather than a broken app shell.
    return false
  }
}

/** Exchange the access token for the session cookie. Returns an error message, or undefined on success. */
export async function login(token: string): Promise<string | undefined> {
  let res: Response
  try {
    res = await fetch(`${AUTH_BASE}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  } catch {
    return 'Could not reach the gateway.'
  }
  if (res.status === 401) return 'That token was not accepted.'
  if (!res.ok) return `Sign-in failed (${res.status}).`
  return undefined
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/logout`, { method: 'POST' }).catch(() => {})
}

/**
 * Session-expiry notification.
 *
 * The cookie outlives any single page load, so the session can end *while the app is open* — signed out in
 * another tab, or the token rotated in config and the gateway restarted. Without this the app polls 401s
 * forever and simply looks broken, with no path back to sign-in short of a manual reload.
 *
 * A tiny emitter rather than context: the producer is `lib/trpc`'s fetch wrapper (not a component) and the
 * consumer is the root gate, so there is no tree between them to thread a value through.
 */
const expiryListeners = new Set<() => void>()

export function onAuthExpired(listener: () => void): () => void {
  expiryListeners.add(listener)
  return () => expiryListeners.delete(listener)
}

export function notifyAuthExpired(): void {
  for (const listener of expiryListeners) listener()
}
