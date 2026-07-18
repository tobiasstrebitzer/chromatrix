// @chromatrix/cdp — CDP multiplexer core.
//
// This package will hold the production mitigating-mux once spikes/s1-cdp-mux proves the approach
// (see docs/PRD.md §7, spike S1). Intended surface:
//
//   - CdpMux:        one upstream WS to Chrome's /devtools/browser endpoint, N downstream clients,
//                    flat-mode session handling, per-client command-id remapping, sessionId event routing.
//   - Interceptor:   pluggable policy over each client->Chrome message (pass / deny / rewrite / handle-local)
//                    plus the ability to inject upstream commands (the leak-mitigation hook).
//   - TargetAcl:     per-client authorization over which targets/tabs a client may attach to.
//
// Kept intentionally empty until S1 settles the interception strategy.

export const CDP_PACKAGE = '@chromatrix/cdp' as const
