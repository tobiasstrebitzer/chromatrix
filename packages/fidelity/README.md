# @chromatrix/fidelity

Browser-fidelity layer: Chrome launch flags, CDP leak-mitigation policy, and the verification probes that
back `pnpm fidelity:check`. The layer that makes a [chromatrix](../../README.md) Chrome instance behave like
an ordinary user's browser instead of an obviously-automated one.

```sh
pnpm add @chromatrix/fidelity
```

## What it does

- **`launchChrome`** — launches real headed (or headless) Chrome with `FIDELITY_LAUNCH_FLAGS`: fingerprint
  hygiene (no `--enable-automation`, `--disable-blink-features=AutomationControlled`) plus
  `ANTI_BACKGROUNDING_FLAGS`/`AUTOMATION_HIDE_FLAGS` so a backgrounded tab keeps rendering and doesn't
  self-report as automated. Cleans stale `Singleton*` profile locks before relaunching.
- **`runtimeEnableSuppressInterceptor`** — a [`@chromatrix/cdp`](../cdp) `Interceptor` that suppresses
  `Runtime.enable` from ever reaching Chrome, while still giving the downstream client a working execution
  context via a synthesized isolated world.
- **Probes** — `probeWebGL` (asserts a real GPU renderer string, not SwiftShader), `probeFingerprint`
  (`navigator.webdriver` and friends), `probeRuntimeEnableGetterTrap` (checks whether the in-page
  `Runtime.enable` getter-leak this package mitigates is even still exploitable on the running Chrome).

## Fidelity check

```sh
pnpm fidelity:check                                 # self-check only (headed Chrome; HEADLESS=1 to hide)
PROFILE_DIR=abs/.profiles/<id> pnpm fidelity:check   # + live anti-bot target matrix against a signed-in profile
```

Findings from the spikes that shaped this package are recorded in
[`docs/FINDINGS.md`](../../docs/FINDINGS.md).

## Development

```sh
pnpm --filter @chromatrix/fidelity run typecheck
pnpm --filter @chromatrix/fidelity run test
pnpm --filter @chromatrix/fidelity run build   # tsdown → build/ (only on prepack/CI)
```

Part of the [chromatrix](../../README.md) monorepo — see the root README for the full architecture.
