import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// The chromatrix dashboard SPA (@chromatrix/web). The gateway is the single origin (:8830): in dev it
// reverse-proxies non-API routes here to Vite (:5181) for HMR, so the browser hits :8830 and the client uses
// relative URLs (identical in dev and prod — no CORS, no VITE_API_URL). The reciprocal proxy below keeps
// :5181 working standalone too. `@/*` → src; plugin-react-swc avoids a Babel/browserslist transform bug.
const root = fileURLToPath(new URL('.', import.meta.url))
const GATEWAY = 'http://localhost:8830'

export default defineConfig({
  root,
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Prepend the @chromatrix/source condition so a future workspace-package import resolves to its TS
    // source in dev (no build step); harmless today since the SPA imports no workspace package.
    conditions: ['@chromatrix/source', ...defaultClientConditions],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5181,
    // The gateway (:8830) is the canonical origin — don't auto-open the bare Vite port.
    open: false,
    // fs.allow up to the workspace root grants @fs access to the pnpm store where @fontsource ships its
    // .woff2/.woff files (outside the apps/web Vite root).
    fs: { allow: ['../..'] },
    // Reciprocal proxy so hitting :5181 directly still reaches the gateway. Normal flow is
    // gateway(:8830) → Vite(:5181). CDP + takeover are WebSocket upgrades (ws: true).
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: true },
      '/trpc': { target: GATEWAY, changeOrigin: true },
      '/mcp': { target: GATEWAY, changeOrigin: true },
      '/cdp': { target: GATEWAY, changeOrigin: true, ws: true },
      '/takeover': { target: GATEWAY, changeOrigin: true, ws: true },
    },
  },
  build: { target: 'es2022' },
})
