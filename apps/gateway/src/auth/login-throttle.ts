// Bounds repeated /api/auth/login failures. The token is 256 bits of randomness, so brute force is not a
// live threat - what this bounds is unbounded guessing *traffic*: a misbehaving script hammering the login
// route forever, filling logs and burning constant-time comparisons. A small in-memory sliding window is
// enough; there is one operator and one credential, so anything fancier (redis, per-user buckets) would be
// machinery without a threat model.
//
// Keyed by the SOCKET address, not `req.ip`: the gateway sets `trust proxy`, which makes `req.ip` read
// X-Forwarded-For - a header any direct client can forge, turning per-IP lockout into no lockout at all.
// Behind a legitimate TLS proxy every client shares the proxy's socket address and therefore one bucket;
// for a single-operator gateway that trade (coarser buckets, unforgeable key) is the right one.

const WINDOW_MS = 60_000
const MAX_FAILURES = 5
/** Hard cap on tracked addresses so a spoofed-source flood cannot grow the map without bound. */
const MAX_TRACKED = 1_000

/** Failure timestamps per socket address, pruned to the window on every consult. */
const failures = new Map<string, number[]>()

function prune(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (kept.length === 0) failures.delete(key)
  else failures.set(key, kept)
  return kept
}

/**
 * Whether login is currently locked for this address. Returns the seconds until the oldest counted failure
 * ages out (for a `Retry-After` header), or undefined when the attempt may proceed. Checked BEFORE the token
 * comparison, so a locked-out caller learns nothing - not even whether the guess would have been right.
 */
export function loginRetryAfter(key: string, now = Date.now()): number | undefined {
  const recent = prune(key, now)
  if (recent.length < MAX_FAILURES) return undefined
  const oldest = recent[recent.length - MAX_FAILURES]!
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000))
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  if (!failures.has(key) && failures.size >= MAX_TRACKED) {
    const eldest = failures.keys().next().value
    if (eldest !== undefined) failures.delete(eldest)
  }
  failures.set(key, [...prune(key, now), now])
}

/** A successful login proves the caller holds the token - stale failure history serves no purpose. */
export function clearLoginFailures(key: string): void {
  failures.delete(key)
}
