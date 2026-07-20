// The chromatrix config schema and its resolution.
//
// Two sources, one precedence rule: **environment overrides file overrides default**. The file
// (`~/.config/chromatrix/config.json`, see paths.ts) is the durable home for the access token and the remote
// host; the `CHROMATRIX_*` env vars override any of it for a single run, which is what makes the same binary
// usable from a shell script, a launchd plist, and a dev terminal without editing a file.
//
// Both halves of the system read this: the *gateway* uses `host`/`port`/`token`/`profilesDir`, the *CLI* uses
// `gatewayUrl`/`token`. One schema rather than two because a single machine is often both, and two schemas
// drift.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod/v4'
import { configPath } from './paths.ts'

/**
 * There is exactly ONE port. Chrome's own debugging ports are ephemeral (`--remote-debugging-port=0`) and
 * bound to loopback — never published — so `port` is the single public surface carrying the dashboard, the
 * REST/tRPC/MCP API, the takeover socket, and the muxed CDP endpoint alike. See docs/PRD.md §6.
 */
export const DEFAULT_PORT = 8830

/** Loopback by default. Binding elsewhere is opt-in precisely because it requires a token to be safe. */
export const DEFAULT_HOST = '127.0.0.1'

export const ConfigSchema = z.object({
  /**
   * The single access token gating every remote surface. Absent means "not yet initialised" — the gateway
   * mints one on first boot (see token.ts); it is not optional at runtime, only at rest.
   */
  token: z.string().min(1).optional(),

  /** Gateway bind address. `0.0.0.0` to accept non-loopback traffic (Tailscale, LAN). */
  host: z.string().min(1).default(DEFAULT_HOST),

  /** Gateway port — the one public port (see DEFAULT_PORT). Coerced, since env vars arrive as strings. */
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),

  /**
   * Where a *client* (the CLI) finds the gateway, e.g. `https://mac-mini.tailnet.ts.net`. Unset means
   * "local gateway" and clients fall back to `http://host:port`.
   */
  gatewayUrl: z.url().optional(),

  /**
   * Origin to advertise in generated URLs (scoped `cdpUrl`s, the takeover viewer link) when the gateway sits
   * behind a proxy or Tailscale name, e.g. `wss://mac-mini.tailnet.ts.net`. Defaults to the bind address,
   * which is only correct for local use.
   */
  publicOrigin: z.string().optional(),

  /**
   * Absolute path to the identity profile root. Absolute because these dirs hold live signed-in sessions and
   * a relative path silently resolves against the process cwd — which differs between a dev shell and launchd.
   */
  profilesDir: z.string().refine(isAbsolute, { message: 'profilesDir must be an absolute path' }).optional(),
})

export type Config = z.infer<typeof ConfigSchema>
/** The on-disk shape: same fields, nothing defaulted — absence is meaningful in a file. */
export type StoredConfig = z.input<typeof ConfigSchema>

/** JSON Schema for the config file, for editor completion / docs. Derived, never hand-written. */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema)
}

/**
 * `CHROMATRIX_*` → config key. Kept as an explicit table rather than derived from the schema keys: the mapping
 * is a public interface (people put these in shell profiles and plists), so it should be greppable and stable
 * even if a schema key is renamed. `CHROMATRIX_PROFILES` keeps its pre-config name — it already shipped.
 */
const ENV_KEYS = {
  CHROMATRIX_TOKEN: 'token',
  CHROMATRIX_HOST: 'host',
  CHROMATRIX_PORT: 'port',
  CHROMATRIX_GATEWAY_URL: 'gatewayUrl',
  CHROMATRIX_PUBLIC_ORIGIN: 'publicOrigin',
  CHROMATRIX_PROFILES: 'profilesDir',
} as const satisfies Record<string, keyof Config>

function envOverrides(): Partial<Record<keyof Config, string>> {
  const out: Partial<Record<keyof Config, string>> = {}
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = process.env[envKey]?.trim()
    // An empty env var means "unset", not "set to empty" — otherwise `CHROMATRIX_TOKEN=` in a stale shell
    // profile would blank a perfectly good token from the file and read as a mysterious auth failure.
    if (value) out[configKey as keyof Config] = value
  }
  return out
}

export class ConfigError extends Error {}

/**
 * Read the config file. Returns `{}` when there is none — a missing file is the normal pre-install state, not
 * an error. A file that exists but is malformed IS an error: silently falling back to defaults there would
 * start an unauthenticated gateway because of a stray comma.
 */
export function readConfigFile(path = configPath()): StoredConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`could not read ${path}: ${(err as Error).message}`)
  }
  try {
    return JSON.parse(raw) as StoredConfig
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`)
  }
}

/**
 * True if the config file is readable by anyone but its owner. The file holds the access token, so this is
 * worth surfacing — but it's a warning rather than a hard failure, because the mode can be legitimately odd on
 * a shared volume and refusing to boot over it would be worse than saying so. Callers decide.
 */
export function isConfigFileExposed(path = configPath()): boolean {
  try {
    return (statSync(path).mode & 0o077) !== 0
  } catch {
    return false // absent → nothing to expose
  }
}

/** File + env + defaults, validated. Throws `ConfigError` with a readable message on invalid input. */
export function loadConfig(path = configPath()): Config {
  const merged = { ...readConfigFile(path), ...envOverrides() }
  const parsed = ConfigSchema.safeParse(merged)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new ConfigError(`invalid chromatrix config (${path} + CHROMATRIX_* env):\n${detail}`)
  }
  return parsed.data
}

/**
 * Persist config, creating `~/.config/chromatrix` if needed.
 *
 * Written `0600`, and the containing dir `0700`, because this file holds the access token. Note the mode
 * argument to `writeFileSync` only applies when the file is *created* — an existing file keeps its mode, so
 * this cannot silently tighten a file the user deliberately loosened, and `isConfigFileExposed` is how a
 * caller notices.
 */
export function writeConfigFile(config: StoredConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}
