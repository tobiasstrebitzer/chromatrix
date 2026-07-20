// Path resolution shared by the module + e2e drivers. The identity registry needs an ABSOLUTE profiles root.
//
// The source of truth is now @chromatrix/shared's config (`profilesDir` in ~/.config/chromatrix/config.json,
// or CHROMATRIX_PROFILES in the environment — the same env var as before). The schema enforces absoluteness,
// so the check that used to live here has moved there. Default remains `<repo>/.profiles` (gitignored — holds
// session cookies), which is what makes a dev checkout work with no config file at all.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '@chromatrix/shared'

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
  return loadConfig().profilesDir ?? join(repoRoot(), '.profiles')
}
