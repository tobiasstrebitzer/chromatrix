# @chromatrix/shared

Code shared between [chromatrix](../../README.md) packages and apps: the config schema + its resolution, and
the access-token primitives. Deliberately lean - **zod is the only runtime dependency**, because
[`@chromatrix/cli`](../../apps/cli) depends on this and every dependency here is one a user installs with
`npx @chromatrix/cli`.

```sh
pnpm add @chromatrix/shared
```

## What it does

- **`loadConfig`** - resolves `~/.config/chromatrix/config.json` (zod-validated), overridden by
  `CHROMATRIX_*` env (`_TOKEN`, `_HOST`, `_PORT`, `_GATEWAY_URL`, `_PUBLIC_ORIGIN`, `_PROFILES`, `_CONFIG`).
  Bare `PORT`/`HOST` are deliberately **not** read. `isConfigFileExposed` flags a config file readable beyond
  its owner (it holds the access token).
- **`generateToken`** / **`ensureToken`** / **`tokensMatch`** - the operator access token: minted on first
  boot, compared in constant time everywhere it's checked.
- **`deriveAgentToken`** - the one-way per-agent CDP token, `HMAC(accessToken, identity ‖ agentId)`:
  recomputed rather than stored, so it survives a restart with no token table, and an agent can never reverse
  it back into the operator credential.

Anything added here later has to clear the same bar: needed by at least two of
{[`gateway`](../../apps/gateway), [`cli`](../../apps/cli), [`web`](../../apps/web), [`core`](../core)}, and
cheap enough to install into every `npx @chromatrix/cli` invocation.

## Development

```sh
pnpm --filter @chromatrix/shared run typecheck
pnpm --filter @chromatrix/shared run test
pnpm --filter @chromatrix/shared run build   # tsdown → build/ (only on prepack/CI)
```

Part of the [chromatrix](../../README.md) monorepo - see the root README for the full architecture.
