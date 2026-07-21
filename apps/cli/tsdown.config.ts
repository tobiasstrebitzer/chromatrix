import { defineConfig } from 'tsdown'

// Build @chromatrix/cli to build/ (ESM, executable). Runs only on prepack/CI — `pnpm --filter
// @chromatrix/cli run start` runs straight from src/ in dev via @swc-node/register, no build step.
export default defineConfig({
  entry: ['./src/index.ts'],
  outDir: 'build',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
})
