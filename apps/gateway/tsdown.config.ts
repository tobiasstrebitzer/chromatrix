import { defineConfig } from 'tsdown'
import swc from 'unplugin-swc'

// Build @chromatrix/gateway to build/ (ESM, executable). Runs only on prepack/CI — dev runs straight from
// src/ via @swc-node/register.
//
// SWC transforms our TS instead of tsdown's default oxc pass: Nest's DI and the global ValidationPipe both
// read `design:paramtypes`, which only `emitDecoratorMetadata` produces — oxc doesn't emit it, and without it
// the built gateway boots but injects nothing and validates nothing. Same jsc config as .swcrc (the dev
// runtime), stated inline so the build can't drift from it silently.
export default defineConfig({
  entry: ['./src/main.ts'],
  outDir: 'build',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  plugins: [
    swc.rolldown({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  deps: { neverBundle: [/^[^./]/] },
})
