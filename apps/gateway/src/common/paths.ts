// Path resolution shared by the module + acceptance test. The identity registry needs an ABSOLUTE profiles
// root; default to `<repo>/.profiles` (gitignored — holds session cookies), overridable via
// CHROMATRIX_PROFILES for prod/Mac-mini profile-location strategies (NEXT-SESSION open thread).

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this file until the workspace root (the dir holding pnpm-workspace.yaml). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not locate repo root (pnpm-workspace.yaml) above the gateway')
}

export function profilesRoot(): string {
  const override = process.env.CHROMATRIX_PROFILES?.trim()
  if (override) {
    if (!isAbsolute(override)) throw new Error(`CHROMATRIX_PROFILES must be absolute, got "${override}"`)
    return override
  }
  return join(repoRoot(), '.profiles')
}
