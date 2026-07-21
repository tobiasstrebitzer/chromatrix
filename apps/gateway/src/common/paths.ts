// Path resolution shared by the module + e2e drivers. The gateway runs in two shapes and this file is where
// they diverge:
//
//   • a DEV CHECKOUT — this file executes from `<repo>/apps/gateway/src/…`. The dashboard is served from
//     `apps/web/dist`, typegen writes into `apps/web/src/generated`, and profiles default to `<repo>/.profiles`
//     (gitignored — holds session cookies), which is what makes a checkout work with no config file at all.
//   • an NPM INSTALL — the built bundle executes from `<pkg>/build/`. The dashboard ships inside the package
//     (`<pkg>/web`, copied from apps/web/dist at pack time), typegen is skipped entirely (its target doesn't
//     exist, and node_modules may be read-only), and profiles default to `~/.local/share/chromatrix/profiles`.
//
// The discriminator is deliberately NOT "is there a pnpm-workspace.yaml above us" alone — an npm install can
// land inside some unrelated monorepo, whose workspace root would then be mistaken for ours. A dev checkout is
// recognised by this file itself living under `<workspace root>/apps/gateway/src`, which no installed copy of
// the bundle ever does (it runs from `build/`).

import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, loadConfig } from '@chromatrix/shared'

const here = dirname(fileURLToPath(import.meta.url))

function findWorkspaceRoot(): string | undefined {
  let dir = here
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** The chromatrix repo root — but only when actually running from a dev checkout; undefined for an install. */
export function devCheckoutRoot(): string | undefined {
  const root = findWorkspaceRoot()
  if (!root) return undefined
  return here.startsWith(join(root, 'apps', 'gateway', 'src') + sep) ? root : undefined
}

/** Where the dashboard's static build lives: `apps/web/dist` in a checkout, `<pkg>/web` in an install. */
export function webDistRoot(): string {
  const root = devCheckoutRoot()
  if (root) return join(root, 'apps', 'web', 'dist')
  // The bundle runs from `<pkg>/build/`; prepack copies the dashboard to `<pkg>/web`.
  return join(here, '..', 'web')
}

/** Where typegen should write the AppRouter type — or nowhere: it only makes sense against web *source*. */
export function typegenTarget(): string | undefined {
  const root = devCheckoutRoot()
  return root ? join(root, 'apps', 'web', 'src', 'generated', 'appRouter.d.ts') : undefined
}

export function profilesRoot(): string {
  const configured = loadConfig().profilesDir
  if (configured) return configured
  const root = devCheckoutRoot()
  return root ? join(root, '.profiles') : join(dataDir(), 'profiles')
}
