// The access token: minting it on first run, and comparing it safely.
//
// One token gates every remote surface (REST/tRPC/MCP, the takeover socket, and the scoped CDP endpoints).
// That is a deliberate simplification for a single-operator self-hosted tool - there is one human here, not a
// user table - but it means the token is the *only* thing between the network and a fleet of signed-in
// browsers, so the primitives below are the ones that have to be right.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { loadConfig, readConfigFile, writeConfigFile } from './config.ts'
import { configPath } from './paths.ts'

/**
 * 32 bytes from the CSPRNG, base64url. Not a UUID: v4 UUIDs carry 122 bits and a recognisable shape, and this
 * is a bearer credential rather than an identifier. base64url so it survives a URL query string untouched -
 * the CDP endpoint carries it as `?token=…` because no CDP client can set a handshake header.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, and length is itself a (minor) leak, so hash-free equality
 * needs the guard below. Compare byte buffers, not strings - a `===` on secrets short-circuits at the first
 * differing character, which is exactly the signal an attacker needs.
 */
export function tokensMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The per-agent CDP credential, derived rather than minted.
 *
 * `HMAC(accessToken, identity ‖ agentId)` - so there is exactly ONE secret on the machine, and an agent's
 * token is recomputable instead of stored. Three consequences worth knowing:
 *
 * - **It survives a gateway restart.** The old random tokens lived in an in-memory map and died with the
 *   process, so every agent had to re-provision after a bounce.
 *   [tokensMatch] on the recomputed value replaces the lookup table entirely.
 * - **It is not reversible.** The gateway cannot recover `agentId` from the token, so the caller names the
 *   agent in the path (`/cdp/<identity>/<agentId>`) and this binds it: claiming another agent's id yields a token you cannot forge.
 * - **There is no per-agent revocation.** Rotating the access token rotates every agent's token at once.
 *   That is the accepted trade (see docs/NEXT-SESSION.md) - the token is a *name*, not a grant: authority
 *   comes from the live TabPool lease, which is destroyed on stop regardless.
 *
 * The NUL separator is load-bearing: identity `"a"` + agent `"b:c"` must not collide with `"a:b"` + `"c"`.
 */
export function deriveAgentToken(accessToken: string, identity: string, agentId: string): string {
  return createHmac('sha256', accessToken).update(`${identity}\u0000${agentId}`).digest('base64url')
}

export interface EnsuredToken {
  token: string
  /** True when this call minted and persisted a new token - the caller should tell the operator once. */
  created: boolean
}

/**
 * Resolve the access token, minting one on first run.
 *
 * "Unless provided" has two forms and both are honoured without writing anything: a token in the config file,
 * or `CHROMATRIX_TOKEN` in the environment. Only a genuinely absent token is generated - and it is written
 * back to the config file, because a token regenerated on every boot would invalidate every CLI and agent
 * credential on restart.
 *
 * The env case deliberately does NOT persist: `CHROMATRIX_TOKEN` is how you run a gateway with an
 * externally-managed secret (a launchd plist, a CI run), and quietly copying that secret into a file on disk
 * is the opposite of what the caller asked for.
 */
export function ensureToken(path = configPath()): EnsuredToken {
  const existing = loadConfig(path).token
  if (existing) return { token: existing, created: false }

  const token = generateToken()
  // Re-read the raw file rather than persisting the resolved config: the resolved one has env overrides and
  // schema defaults folded in, and writing those back would silently freeze a one-off `CHROMATRIX_PORT=…`
  // into permanent config.
  writeConfigFile({ ...readConfigFile(path), token }, path)
  return { token, created: true }
}
