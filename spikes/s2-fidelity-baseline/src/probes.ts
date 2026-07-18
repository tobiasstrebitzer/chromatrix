// S2 probes: GPU/WebGL fingerprint, automation-fingerprint hygiene, per-tab RAM, occluded-window rendering.
// All run against a real HEADED Chrome (see launch-chrome.ts). See docs/PRD.md §7 (S2).

import { execFileSync } from 'node:child_process'
import { CdpClient } from './cdp-client.ts'

async function attach(client: CdpClient, targetId: string): Promise<string> {
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  return r.result?.value as T
}

// ── GPU / WebGL ───────────────────────────────────────────────────────────────────────────────────────
export interface WebGLInfo {
  vendor: string | null
  renderer: string | null
  unmaskedVendor: string | null
  unmaskedRenderer: string | null
  isAppleMetal: boolean
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

// ── Automation fingerprint hygiene ──────────────────────────────────────────────────────────────────────
export interface Fingerprint {
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

// ── Per-instance RAM (sum RSS of all processes for this Chrome's unique userDataDir) ────────────────────
export function instanceRssMb(userDataDir: string): number {
  const out = execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  let kb = 0
  for (const line of out.split('\n')) {
    if (!line.includes(userDataDir)) continue
    const m = line.trim().match(/^(\d+)\s/)
    if (m) kb += Number(m[1])
  }
  return Math.round(kb / 1024)
}

export interface RamResult {
  baselineMb: number
  afterMb: number
  tabsOpened: number
  loaded: number
  perTabMb: number
}

export async function probeRam(
  client: CdpClient,
  userDataDir: string,
  urls: string[],
): Promise<RamResult> {
  await new Promise((r) => setTimeout(r, 800))
  const baselineMb = instanceRssMb(userDataDir)

  let loaded = 0
  const targetIds: string[] = []
  for (const url of urls) {
    try {
      const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url })
      targetIds.push(targetId)
      const sid = await attach(client, targetId)
      await client.send('Page.enable', {}, sid)
      // Give the page time to load; tolerate slow/failed loads.
      await Promise.race([
        new Promise<void>((res) => {
          client.on('Page.loadEventFired', () => res())
        }),
        new Promise<void>((res) => setTimeout(res, 6000)),
      ])
      loaded++
    } catch {
      /* target failed to open/load — counts toward tabsOpened lower bound */
    }
  }
  await new Promise((r) => setTimeout(r, 1500))
  const afterMb = instanceRssMb(userDataDir)
  const perTabMb = targetIds.length ? Math.round((afterMb - baselineMb) / targetIds.length) : 0

  // Cleanup opened tabs.
  for (const t of targetIds) await client.send('Target.closeTarget', { targetId: t }).catch(() => {})

  return { baselineMb, afterMb, tabsOpened: targetIds.length, loaded, perTabMb }
}

// ── Occluded-window rendering (validates the anti-backgrounding flags) ──────────────────────────────────
export interface OcclusionResult {
  framesWhileOccluded: number
  throttled: boolean
  note: string
}

const SAME_BOUNDS = { left: 120, top: 120, width: 820, height: 620 } as const

export async function probeOcclusion(client: CdpClient): Promise<OcclusionResult> {
  // Two overlapping windows; B fully covers A so A is occluded.
  const { targetId: aId } = await client.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  })
  const { targetId: bId } = await client.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  })
  const aSid = await attach(client, aId)
  const bSid = await attach(client, bId)

  // Force both windows to identical bounds so B occludes A.
  for (const id of [aId, bId]) {
    try {
      const { windowId } = await client.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: id })
      await client.send('Browser.setWindowBounds', { windowId, bounds: { ...SAME_BOUNDS, windowState: 'normal' } })
    } catch {
      /* window bounds control may vary; occlusion still approximated by z-order */
    }
  }

  // Start a rAF counter in A, then raise B to occlude A.
  await evaluate(client, aSid, `window.__frames = 0; (function loop(){ window.__frames++; requestAnimationFrame(loop); })(); 'started'`)
  await client.send('Page.bringToFront', {}, bSid)
  await new Promise((r) => setTimeout(r, 2000))
  const framesWhileOccluded = await evaluate<number>(client, aSid, 'window.__frames')

  await client.send('Target.closeTarget', { targetId: aId }).catch(() => {})
  await client.send('Target.closeTarget', { targetId: bId }).catch(() => {})

  // At 60fps, ~120 frames in 2s. A throttled/backgrounded window drops to ~2 (1fps) or 0.
  const throttled = framesWhileOccluded < 30
  return {
    framesWhileOccluded,
    throttled,
    note: throttled
      ? 'occluded window is being throttled — anti-backgrounding flags NOT effective'
      : 'occluded window kept rendering — anti-backgrounding flags effective',
  }
}

export { attach }
