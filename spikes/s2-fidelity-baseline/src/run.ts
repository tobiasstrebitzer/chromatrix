// S2 runner. Launches ONE real headed Chrome and measures the fidelity/capacity baseline that does NOT
// require a logged-in identity: GPU/WebGL fingerprint, automation-fingerprint hygiene, per-tab RAM, and
// occluded-window rendering. The logged-in target matrix (LinkedIn/Google) + Cloudflare/DataDome pass-rates
// are deferred until S4 provides the manual-login tool (see docs/PRD.md §7). Prints a report.
//
//   pnpm s2     # from repo root — a real Chrome window WILL appear (required for the GPU fingerprint)

import { launchChrome } from './launch-chrome.ts'
import { CdpClient } from './cdp-client.ts'
import { probeWebGL, probeFingerprint, probeRam, probeOcclusion, attach } from './probes.ts'

// Public, no-login pages with a realistic memory footprint spread. Network required for a realistic RAM
// number; failures are tolerated and reported as a lower bound.
const RAM_URLS = [
  'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
  'https://news.ycombinator.com/',
  'https://www.bbc.com/news',
  'https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API',
  'https://www.reddit.com/r/programming/',
  'https://github.com/steel-dev/steel-browser',
]

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: process.env.HEADLESS === '1' })
  console.log(`Chrome up (headed=${process.env.HEADLESS !== '1'}): ${chrome.browserWsUrl}`)
  const client = await CdpClient.connect(chrome.browserWsUrl)
  try {
    // A scratch page for the JS fingerprint probes. Use a secure (https) context so navigator.userAgentData
    // and navigator.deviceMemory are exposed (about:blank suppresses them and skews the hygiene read).
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const sid = await attach(client, targetId)
    await client.send('Page.enable', {}, sid)
    try {
      await client.send('Page.navigate', { url: 'https://example.com/' }, sid)
      await Promise.race([
        new Promise<void>((res) => client.on('Page.loadEventFired', () => res())),
        new Promise<void>((res) => setTimeout(res, 6000)),
      ])
    } catch {
      /* offline — probes still run, uaData/deviceMemory may read null */
    }

    const webgl = await probeWebGL(client, sid)
    const fp = await probeFingerprint(client, sid)
    const occlusion = await probeOcclusion(client)
    const ram = await probeRam(client, chrome.userDataDir, RAM_URLS)
    await client.send('Target.closeTarget', { targetId }).catch(() => {})

    console.log('\n══════════════════════════════════════════════════════════════════════════════')
    console.log(' chromatrix · S2 — fidelity + capacity baseline (no-login parts)')
    console.log('══════════════════════════════════════════════════════════════════════════════\n')

    console.log('── GPU / WebGL fingerprint (the macOS fidelity advantage) ─────────────────────')
    console.log(`  VENDOR            : ${webgl.vendor}`)
    console.log(`  RENDERER          : ${webgl.renderer}`)
    console.log(`  UNMASKED_VENDOR   : ${webgl.unmaskedVendor}`)
    console.log(`  UNMASKED_RENDERER : ${webgl.unmaskedRenderer}`)
    console.log(
      `  → ${
        webgl.isAppleMetal
          ? '✅ authentic Apple/Metal GPU renderer (headless/SwiftShader cannot fake this)'
          : webgl.isSoftware
            ? '❌ SOFTWARE renderer (SwiftShader/LLVMpipe) — blocklisted, not authentic'
            : '⚠  non-Apple/Metal, non-software renderer — inspect the string above'
      }`,
    )

    console.log('\n── Automation fingerprint hygiene ────────────────────────────────────────────')
    console.log(`  navigator.webdriver     : ${fp.webdriver}  ${fp.webdriver ? '❌ (leaks automation)' : '✅'}`)
    console.log(`  userAgent               : ${fp.userAgent}`)
    console.log(`  uaData brands           : ${fp.uaBrands}`)
    console.log(`  platform                : ${fp.platform}`)
    console.log(`  hardwareConcurrency     : ${fp.hardwareConcurrency}`)
    console.log(`  deviceMemory            : ${fp.deviceMemory}`)
    console.log(`  languages               : ${fp.languages}`)
    console.log(`  maxTouchPoints          : ${fp.maxTouchPoints}`)
    console.log(`  window.chrome present   : ${fp.hasWindowChrome}  ${fp.hasWindowChrome ? '✅' : '⚠  (missing looks automated)'}`)
    console.log(`  navigator.plugins.length: ${fp.plugins}`)
    const hasHeadlessUA = /headless/i.test(fp.userAgent)
    console.log(`  → ${fp.webdriver || hasHeadlessUA ? '❌ automation tells present' : '✅ no obvious automation tells in these signals'}`)

    console.log('\n── Occluded-window rendering (anti-backgrounding flags) ──────────────────────')
    console.log(`  frames rendered in 2s while occluded: ${occlusion.framesWhileOccluded}`)
    console.log(`  → ${occlusion.throttled ? '❌' : '✅'} ${occlusion.note}`)

    console.log('\n── Per-instance RAM / capacity ───────────────────────────────────────────────')
    console.log(`  baseline (1 blank tab)  : ${ram.baselineMb} MB`)
    console.log(`  after opening ${ram.tabsOpened} tabs   : ${ram.afterMb} MB  (${ram.loaded} loaded)`)
    console.log(`  → ~${ram.perTabMb} MB per active tab (real sites)`)
    const perTab = ram.perTabMb > 0 ? ram.perTabMb : 250
    // Fleet math matters: each IDENTITY is its own Chrome instance carrying a browser/GPU/network base
    // (~1GB here, tabs on top). So budget ≈ identities×base + totalTabs×perTab, not just tabs.
    const instanceBaseMb = Math.max(600, ram.baselineMb - perTab) // baseline included ~1 tab
    const v1Mb = 5 * instanceBaseMb + 10 * perTab
    console.log(`  → per-identity instance base ≈ ${instanceBaseMb} MB; marginal tab ≈ ${perTab} MB`)
    console.log(`  → v1 target (5 identities × base + 10 tabs) ≈ ${(v1Mb / 1024).toFixed(1)} GB resident`)
    console.log(
      `    fits 16GB (tight) / comfortable on 32GB+. Fewer identities or lazy-launch lowers this a lot.`,
    )

    console.log('\n── Deferred (needs S4 login tool / real targets) ─────────────────────────────')
    console.log('  LinkedIn / Google logged-in behaviour, and Cloudflare-Turnstile / DataDome pass-rates.')
    console.log('  These set the true fidelity ceiling and are the decisive S2 measurement — run after S4.')
    console.log('══════════════════════════════════════════════════════════════════════════════\n')
  } finally {
    client.close()
    chrome.close()
  }
}

main().catch((e) => {
  console.error('S2 run failed:', e)
  process.exitCode = 1
})
