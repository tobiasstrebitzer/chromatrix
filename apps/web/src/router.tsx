import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { RootLayout } from './components/shell/RootLayout'
import { SessionsView } from './views/SessionsView'
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
  component: TakeoverRouteView,
})

function TakeoverRouteView() {
  const { identity } = takeoverIdentityRoute.useParams()
  return <TakeoverView identity={identity} />
}

const routeTree = rootRoute.addChildren([indexRoute, sessionsRoute, takeoverIndexRoute, takeoverIdentityRoute])

export const router = createRouter({ routeTree, history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
