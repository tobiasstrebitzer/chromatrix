// Fidelity verification probes: the CDP-based assertions that prove an identity Chrome presents as the real
// browser it is. Promoted from spikes S1 (Runtime.enable getter-trap) and S2 (WebGL renderer, automation
// fingerprint). Pure — each takes a raw CdpClient + an attached page sessionId and reads the page; capacity
// measurements (RAM, occlusion) are eval-only and live in eval.ts, not here. See docs/PRD.md §7.

import type { CdpClient } from '@chromatrix/cdp'

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<{ result?: { value?: T } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  return r.result?.value as T
}

// ── GPU / WebGL — the macOS advantage (authentic Apple/Metal renderer) ──────────────────────────────────
export interface WebGLInfo {
  vendor: string | null
  renderer: string | null
  unmaskedVendor: string | null
  unmaskedRenderer: string | null
  /** The one signal headless/Linux cannot fake: a real on-screen Apple GPU via the Metal ANGLE backend. */
  isAppleMetal: boolean
  /** SwiftShader/LLVMpipe/software — the blocklisted give-away of a synthetic/headless GPU. */
  isSoftware: boolean
}

const WEBGL_EXPR = `
  (function () {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { vendor: null, renderer: null, unmaskedVendor: null, unmaskedRenderer: null };
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    } catch (e) { return { vendor: String(e), renderer: null, unmaskedVendor: null, unmaskedRenderer: null }; }
  })()
`

export async function probeWebGL(client: CdpClient, sessionId: string): Promise<WebGLInfo> {
  const raw = await evaluate<Omit<WebGLInfo, 'isAppleMetal' | 'isSoftware'>>(client, sessionId, WEBGL_EXPR)
  const r = (raw.unmaskedRenderer ?? raw.renderer ?? '').toLowerCase()
  return {
    ...raw,
    isAppleMetal: r.includes('apple') && r.includes('metal'),
    isSoftware: r.includes('swiftshader') || r.includes('llvmpipe') || r.includes('software'),
  }
}

// ── Automation-fingerprint hygiene ──────────────────────────────────────────────────────────────────────
// `userAgentData` and `deviceMemory` are only exposed in a SECURE context, so the caller must run this on a
// page served over https (the eval navigates to https://example.com first) for those fields to be populated.
export interface Fingerprint {
  /** Must be `false`. A plain --remote-debugging-port launch leaks `true`; the fidelity flags close it. */
  webdriver: unknown
  userAgent: string
  uaBrands: string | null
  platform: string
  hardwareConcurrency: number
  deviceMemory: unknown
  languages: string
  maxTouchPoints: number
  hasWindowChrome: boolean
  plugins: number
}

const FINGERPRINT_EXPR = `
  ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    uaBrands: navigator.userAgentData ? navigator.userAgentData.brands.map(function(b){return b.brand+' '+b.version}).join(', ') : null,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    languages: (navigator.languages || []).join(','),
    maxTouchPoints: navigator.maxTouchPoints,
    hasWindowChrome: typeof window.chrome !== 'undefined',
    plugins: navigator.plugins.length
  })
`

export async function probeFingerprint(client: CdpClient, sessionId: string): Promise<Fingerprint> {
  return evaluate<Fingerprint>(client, sessionId, FINGERPRINT_EXPR)
}

// ── Runtime.enable getter-trap (the classic in-page CDP tell) ────────────────────────────────────────────
// The anti-bot signal the research feared: enabling Runtime and console.log-ing an object used to make Chrome
// build a property preview that INVOKED accessor getters, revealing an attached debugger. S1 confirmed
// Chrome 150 closed this (accessors serialize as {type:"accessor"} without firing). This probe re-checks it
// on demand: it enables Runtime on the given session, so run it on a throwaway page, not a live agent tab.
export interface GetterTrapResult {
  /** True if the getter fired — the leak is OPEN (bad). False = Chrome did not invoke it (leak closed). */
  getterFired: boolean
  /** True when the leak is closed (the healthy state): getter never invoked during console preview. */
  leakClosed: boolean
}

export async function probeRuntimeEnableGetterTrap(client: CdpClient, sessionId: string): Promise<GetterTrapResult> {
  await client.send('Runtime.enable', {}, sessionId)
  await client.send(
    'Runtime.evaluate',
    {
      expression: `
        window.__hit = false;
        var t = { plain: 'v' };
        Object.defineProperty(t, 'id', { enumerable: true, get: function(){ window.__hit = true; return 42; } });
        console.log('LEAKTEST', t);
        'ok'`,
    },
    sessionId,
  )
  // Give Chrome time to serialize the console argument (which is what would fire the getter, if it leaked).
  await new Promise((r) => setTimeout(r, 400))
  const getterFired = !!(await evaluate<boolean>(client, sessionId, 'window.__hit === true'))
  return { getterFired, leakClosed: !getterFired }
}
