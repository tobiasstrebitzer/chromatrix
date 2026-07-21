# @chromatrix/web

The [chromatrix](../../README.md) dashboard SPA - React 19 + Vite + Tailwind v4, consumed through the
gateway over tRPC. Not a standalone deployable: it's built and served by
[`@chromatrix/gateway`](../gateway)'s `ServeStaticModule`, so it's never published to npm on its own.

Achromatic design system (retuned against the Vercel dashboard as reference): an inset panel on a darker
canvas, hairline borders, no brand hue - the "accent" is just the inverse of the canvas, so the primary
action reads as primary by contrast alone and colour is reserved for state. CSS-variable tokens, light/dark
on `data-theme`, Inter + JetBrains Mono, `@base-ui/react` (Select, AlertDialog) + `sonner` for toasts, the
rest of `ui/` hand-rolled.

## Views

- **Sessions** - the provisioning surface as a UI: identities as collapsible rows, tabs as cards with live
  polled screenshot thumbnails, create/start/stop/delete lifecycle, per-tab viewport controls.
- **Takeover** - live-view + human control: connects to the raw-WS `/takeover/<id>/ws`, renders the CDP
  screencast, and forwards mouse/keyboard/wheel as `Input.dispatch*` (`isTrusted`) events - the mechanism a
  human uses to complete an interactive verification gate by hand.

## Layout

```
src/
  main.tsx · App.tsx · router.tsx          # entry, providers, hash-history route tree
  styles/    tokens.css · globals.css · fonts.css
  lib/       utils(cn) · theme · usePersistedState · trpc · useGateway · activity · types
  components/ brand/(Logo)  shell/(AppShell·Sidebar·SidebarRail·TopBar·ThemeToggle)  ui/  sessions/
  views/     SessionsView · TakeoverView
  generated/ appRouter.d.ts               # tRPC AppRouter type - emitted by the gateway's typegen on boot
```

## Running

The gateway is the single origin (`:8830`) in dev and prod, so the SPA always uses relative URLs - no CORS,
no `VITE_API_URL`.

- **Dev**: `pnpm dev` (turbo, from the repo root) runs Vite (`:5181`) + the gateway with `VITE_DEV_URL` set,
  so the gateway reverse-proxies non-API routes to Vite for HMR. Open the gateway origin, not the Vite port.
- **Prod**: `pnpm --filter @chromatrix/web run build` → the gateway's `ServeStaticModule` serves `dist/` on
  the same port as `/api` + `/trpc` + `/mcp`.

Part of the [chromatrix](../../README.md) monorepo - see the root README for the full architecture.
