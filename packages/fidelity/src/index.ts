// @chromatrix/fidelity — Chrome launch flags, the Runtime.enable-suppression Interceptor, and the launcher.
// Policy that plugs into @chromatrix/cdp's mux. See docs/PRD.md §4 (fidelity layer) and §7 (spikes S1/S2).

export { ANTI_BACKGROUNDING_FLAGS, AUTOMATION_HIDE_FLAGS, FIDELITY_LAUNCH_FLAGS } from './flags.ts'
export { launchChrome, type ChromeHandle, type LaunchOptions } from './launch.ts'
export { runtimeEnableSuppressInterceptor } from './mitigation.ts'
export {
  probeFingerprint,
  probeRuntimeEnableGetterTrap,
  probeWebGL,
  type Fingerprint,
  type GetterTrapResult,
  type WebGLInfo,
} from './probes.ts'

export const FIDELITY_PACKAGE = '@chromatrix/fidelity' as const
