import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { RootLayout } from './components/shell/RootLayout'
import { SessionsView } from './views/SessionsView'
import { SettingsView } from './views/SettingsView'
import { TakeoverView } from './views/TakeoverView'

// Hash history: the dashboard is served as a static bundle by the gateway (no server-side SPA fallback for
// deep paths), so hash routing keeps deep links + refresh working. The startTakeover action returns
// `…/#/takeover/<identity>`, which lands here.
const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/sessions' })
  },
})

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsView,
})

const takeoverIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/takeover',
  component: () => <TakeoverView />,
})

const takeoverIdentityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/takeover/$identity',
  // `?target=` lets Sessions link straight to the tab whose thumbnail was clicked, instead of dropping the
  // human on whichever tab the hub happened to attach to.
  validateSearch: (search: Record<string, unknown>): { target?: string } => ({
    target: typeof search.target === 'string' && search.target ? search.target : undefined,
  }),
  component: TakeoverRouteView,
})

function TakeoverRouteView() {
  const { identity } = takeoverIdentityRoute.useParams()
  const { target } = takeoverIdentityRoute.useSearch()
  return <TakeoverView identity={identity} target={target} />
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsView,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionsRoute,
  takeoverIndexRoute,
  takeoverIdentityRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree, history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
