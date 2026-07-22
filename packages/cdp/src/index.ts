// @chromatrix/cdp - CDP client + mitigating multiplexer core. Mechanism only; fidelity policies that plug
// into the Interceptor seam live in @chromatrix/fidelity. See docs/FINDINGS.md.

export { CdpClient } from './client.ts'
export { CdpMux } from './mux.ts'
export { unrestrictedScope, type ClientScope } from './scope.ts'
export {
  transparentInterceptor,
  type ClientMessage,
  type InterceptContext,
  type InterceptDecision,
  type Interceptor,
} from './interceptor.ts'

export const CDP_PACKAGE = '@chromatrix/cdp' as const
