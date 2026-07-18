# @chromatrix/web

The chromatrix dashboard SPA — React 19 + Vite + Tailwind v4, consumed through the NestJS gateway over tRPC.
Design system ported from the silkweave/gtm stack (CSS-variable tokens + Tailwind v4 `@theme`, light/dark on
`data-theme`, Inter + JetBrains Mono, `cn()`), rebranded to the chromatrix cyan accent + "chroma" spectrum mark.

## Views

- **Sessions** — the provisioning surface as a UI: start an identity (a real headed Chrome), then per running
  identity lease exclusive tabs for named agents. Each lease shows the scoped, single-use CDP URL to hand an
  agent (copy button), plus per-identity Health / Stop / Takeover. Polls `gatewayListSessions` over tRPC.
- **Takeover** — live-view + human control: connects to the raw-WS `/takeover/<id>/ws`, renders the CDP
  screencast, and forwards mouse/keyboard/wheel as `Input.dispatch*` (isTrusted) events (the S4 mechanism).

## Layout

```
src/
  main.tsx · App.tsx · router.tsx          # entry, providers, hash-history route tree
  styles/    tokens.css · globals.css · fonts.css
  lib/       utils(cn) · theme · usePersistedState · trpc · useGateway · types · sessionsContext
  components/ brand/  shell/(AppShell·Sidebar·TopBar·ThemeToggle·RootLayout)  ui/(Button·Badge·Card·Input)
  views/     SessionsView · TakeoverView
  generated/ appRouter.d.ts               # tRPC AppRouter type — emitted by the gateway's typegen on boot
```

## Running

The gateway is the single origin (`:8830`) in dev and prod, so the SPA always uses relative URLs — no CORS,
no `VITE_API_URL`.

- **Dev**: `pnpm dev` (turbo) runs Vite (`:5181`) + the gateway with `VITE_DEV_URL` set, so the gateway
  reverse-proxies non-API routes to Vite for HMR. Open the gateway origin, not the Vite port.
- **Prod**: `pnpm --filter @chromatrix/web build` → the gateway's `ServeStaticModule` serves `dist/` on the
  same port as `/api` + `/trpc` + `/mcp`.
