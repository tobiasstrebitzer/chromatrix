import { defineConfig } from 'tsdown'

// Build @chromatrix/cdp to build/ (ESM + .d.mts). Runs only on prepack/CI (turbo `^build`), never in
// dev — apps resolve the `@chromatrix/source` export condition straight to src/ during development.
export default defineConfig({
  entry: ['./src/index.ts'],
  outDir: 'build',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
})
