// Identity registry - the id → profile-dir mapping (PRD §4, NEXT-SESSION §2). An "identity" is one signed-in
// browser persona: one persistent `--user-data-dir` under `.profiles/<id>/` holding its cookies/session. The
// registry is deliberately thin (the profile dir IS the durable state; we don't duplicate it in a DB) - it
// just resolves ids to dirs, creates the dir on demand, and lists what's on disk.

import { mkdirSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * A valid identity id: a lowercase kebab slug, filesystem- and URL-safe.
 *
 * Deliberately narrow. The id is a path segment in `/cdp/<identity>/<agentId>` and a directory name under
 * `.profiles/`, so it should need no escaping in either - one canonical spelling, readable in a URL, safe on
 * disk. Underscores are excluded so there is exactly one separator rather than two interchangeable ones
 * (`work_twitter` and `work-twitter` being different identities is a footgun, not a feature). A trailing
 * separator is excluded too, so ids can't differ only by punctuation at the end.
 */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface Identity {
  readonly id: string
  readonly profileDir: string
}

/** Bounded so the id stays a comfortable path segment and directory name on every filesystem. */
export const MAX_IDENTITY_ID_LENGTH = 64

export function assertValidIdentityId(id: string): void {
  // Length is checked separately from shape so the two failures read differently - "too long" and "has a
  // character that isn't allowed" are different mistakes and deserve different messages.
  if (id.length > MAX_IDENTITY_ID_LENGTH) {
    throw new Error(`invalid identity id "${id}" - ${id.length} chars, max is ${MAX_IDENTITY_ID_LENGTH}`)
  }
  if (!ID_RE.test(id)) {
    throw new Error(
      `invalid identity id "${id}" - must be a lowercase kebab slug: letters and digits separated by single ` +
        `dashes (e.g. "work-twitter"), no underscores, spaces, uppercase, or leading/trailing dashes`,
    )
  }
}

export class IdentityRegistry {
  /** @param profilesRoot absolute path to the dir holding per-identity profiles (e.g. <repo>/.profiles). */
  constructor(private readonly profilesRoot: string) {
    if (!isAbsolute(profilesRoot)) throw new Error(`profilesRoot must be absolute, got "${profilesRoot}"`)
  }

  /** Resolve an id to its Identity (does not create the dir). */
  get(id: string): Identity {
    assertValidIdentityId(id)
    return { id, profileDir: join(this.profilesRoot, id) }
  }

  /** True if the identity's profile dir already exists on disk. */
  exists(id: string): boolean {
    return existsSync(this.get(id).profileDir)
  }

  /** Ensure the identity's profile dir exists (idempotent), returning the Identity. */
  create(id: string): Identity {
    const identity = this.get(id)
    mkdirSync(identity.profileDir, { recursive: true })
    return identity
  }

  /**
   * Delete the identity's profile dir and everything under it. Irreversible: the profile dir IS the identity,
   * so this destroys the signed-in session (cookies, tokens, local storage), not just a record pointing at it.
   * Callers must ensure no Chrome is bound to the dir first - deleting a live profile out from under Chrome
   * leaves it writing into unlinked inodes.
   */
  remove(id: string): void {
    rmSync(this.get(id).profileDir, { recursive: true, force: true })
  }

  /** Every identity with a profile dir on disk, sorted by id. */
  list(): Identity[] {
    if (!existsSync(this.profilesRoot)) return []
    return readdirSync(this.profilesRoot)
      .filter((name) => ID_RE.test(name) && statSync(join(this.profilesRoot, name)).isDirectory())
      .sort()
      .map((id) => ({ id, profileDir: join(this.profilesRoot, id) }))
  }
}
