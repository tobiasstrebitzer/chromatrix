// @chromatrix/cdp — CDP client + mitigating multiplexer core. Mechanism only; stealth policies that plug
// into the Interceptor seam live in @chromatrix/stealth. See docs/PRD.md §3/§4.

export { CdpClient } from './client.ts'
export { CdpMux } from './mux.ts'
export {
  transparentInterceptor,
  type ClientMessage,
  type InterceptContext,
  type InterceptDecision,
  type Interceptor,
} from './interceptor.ts'

export const CDP_PACKAGE = '@chromatrix/cdp' as const
