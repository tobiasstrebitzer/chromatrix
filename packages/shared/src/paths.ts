// Where chromatrix keeps its user-level config. Follows the XDG convention (`XDG_CONFIG_HOME`, falling back
// to `~/.config`) rather than hardcoding `~/.config`, so a machine that relocates its config dir keeps working.
//
// This file is deliberately free of any zod/config imports: the CLI needs to know *where* the config lives
// before it can know whether one exists, and the config loader needs these paths to read it.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/.config/chromatrix` (or `$XDG_CONFIG_HOME/chromatrix`). */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'chromatrix')
}

/**
 * `~/.local/share/chromatrix` (or `$XDG_DATA_HOME/chromatrix`) - durable machine-local data, as opposed to
 * configuration. What lives here today: the default identity-profiles root when the gateway runs from an npm
 * install (a dev checkout keeps `<repo>/.profiles`). Kept separate from `configDir` because profiles are
 * gigabytes of Chrome state you'd exclude from a dotfiles sync, while config is a 200-byte file you'd keep.
 */
export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share'), 'chromatrix')
}

/**
 * The config file itself. `CHROMATRIX_CONFIG` overrides the whole path - useful for tests, for running two
 * gateways on one machine, and for pointing a CLI at a second remote without clobbering the default.
 */
export function configPath(): string {
  const override = process.env.CHROMATRIX_CONFIG?.trim()
  return override && override.length > 0 ? override : join(configDir(), 'config.json')
}
