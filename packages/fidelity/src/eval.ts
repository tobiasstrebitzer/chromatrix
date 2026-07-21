// chromatrix fidelity eval - the runnable fidelity self-check + optional live target matrix. Promoted from
// spikes S1/S2 so the assertions live with the product, not a throwaway. Runs against @chromatrix/fidelity's
// own launcher + probes, so what it verifies is exactly what the gateway ships.
//
//   pnpm fidelity:check                                  # self-check only (launches a headed Chrome)
//   HEADLESS=1 pnpm fidelity:check                       # no visible window (WebGL will read as software)
//   PROFILE_DIR=/abs/.profiles/x pnpm fidelity:check     # + live target matrix against a signed-in profile
//   CDP_URL=ws://127.0.0.1:PORT/devtools/browser/… pnpm fidelity:check   # attach to an already-running Chrome
//   CLOUDFLARE_URL=… DATADOME_URL=… PROFILE_DIR=… pnpm fidelity:check     # add the hard anti-bot targets
//
// The self-check needs no login. The target matrix only runs when a PROFILE_DIR/CDP_URL points at a Chrome
// that already carries a human-completed login (the gateway's takeover flow, or a hand-launched profile).

import { CdpClient } from '@chromatrix/cdp'
import { launchChrome, probeFingerprint, probeRuntimeEnableGetterTrap, probeWebGL } from './index.ts'

const HEADLESS = process.env.HEADLESS === '1'

async function getBrowser(): Promise<{ client: CdpClient; userDataDir: string | null; close: () => void }> {
  if (process.env.CDP_URL) {
    const client = await CdpClient.connect(process.env.CDP_URL)
    return { client, userDataDir: null, close: () => client.close() }
  }
  const chrome = await launchChrome({ headless: HEADLESS, profileDir: process.env.PROFILE_DIR })
  const client = await CdpClient.connect(chrome.browserWsUrl)
  return {
    client,
    userDataDir: chrome.userDataDir,
    close: () => {
      client.close()
      chrome.close()
    },
  }
}

interface Tab {
  targetId: string
  sessionId: string
}

async function openTab(client: CdpClient, url: string): Promise<Tab> {
  const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', { url })
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Page.enable', {}, sessionId)
  await client.send('Network.enable', {}, sessionId)
  return { targetId, sessionId }
}

async function settle(client: CdpClient, sessionId: string, ms: number): Promise<void> {
  await Promise.race([
    new Promise<void>((res) => client.on('Page.loadEventFired', (_p, sid) => sid === sessionId && res())),
    new Promise<void>((res) => setTimeout(res, ms)),
  ])
  await new Promise((r) => setTimeout(r, 2500)) // let JS challenges / SPA hydration run
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<{ result?: { value?: T } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  return r.result?.value as T
}

async function closeTab(client: CdpClient, targetId: string): Promise<void> {
  await client.send('Target.closeTarget', { targetId }).catch(() => {})
}

const lines: string[] = []
let hardFailure = false

// ── Self-check: fidelity signals that need no login ─────────────────────────────────────────────────────
async function selfCheck(client: CdpClient): Promise<void> {
  // Navigate to a real https origin: userAgentData/deviceMemory are only exposed in a secure context.
  const tab = await openTab(client, 'https://example.com/')
  await settle(client, tab.sessionId, 12000)

  const gl = await probeWebGL(client, tab.sessionId)
  const fp = await probeFingerprint(client, tab.sessionId)

  const glOk = gl.isAppleMetal && !gl.isSoftware
  if (!glOk && !HEADLESS) hardFailure = true
  lines.push('── fidelity self-check ─────────────────────────────────────────')
  lines.push(`  WebGL renderer   : ${glOk ? '✅' : HEADLESS ? '⬜' : '❌'} ${gl.unmaskedRenderer ?? gl.renderer ?? '(none)'}`)
  if (HEADLESS && !glOk) lines.push('                     (software renderer expected under HEADLESS=1 - run headed for the real read)')

  const wdOk = fp.webdriver === false
  if (!wdOk) hardFailure = true
  lines.push(`  navigator.webdriver: ${wdOk ? '✅ false' : '❌ ' + String(fp.webdriver) + ' (automation tell - check the fidelity flags)'}`)
  lines.push(`  userAgentData    : ${fp.uaBrands ? '✅ ' + fp.uaBrands : '⬜ (null - not a secure context?)'}`)
  lines.push(`  platform / cores : ${fp.platform} / ${fp.hardwareConcurrency}   deviceMemory=${String(fp.deviceMemory)}   window.chrome=${fp.hasWindowChrome}`)
  lines.push(`  userAgent        : ${fp.userAgent}`)
  await closeTab(client, tab.targetId)

  // Getter-trap on a throwaway page (it enables Runtime, which is why it must not touch a live agent tab).
  const trapTab = await openTab(client, 'about:blank')
  const trap = await probeRuntimeEnableGetterTrap(client, trapTab.sessionId)
  if (!trap.leakClosed) hardFailure = true
  lines.push(`  Runtime.enable trap: ${trap.leakClosed ? '✅ closed (getter not invoked)' : '❌ OPEN - getter fired, debugger is observable'}`)
  await closeTab(client, trapTab.targetId)
}

function classify(title: string, bodyText: string): 'pass' | 'gated' | 'blocked' {
  const t = `${title}\n${bodyText}`.toLowerCase()
  if (/(sorry, you have been blocked|access denied|you don't have permission|error 1020)/.test(t)) return 'blocked'
  if (/(just a moment|checking your browser|attention required|verify you are human|enable javascript and cookies|cf-mitigated|needs to review the security)/.test(t))
    return 'gated'
  return 'pass'
}

// ── Target matrix: login-dependent, real anti-bot targets ───────────────────────────────────────────────
async function targetMatrix(client: CdpClient): Promise<void> {
  lines.push('')
  lines.push('── target matrix (logged-in, real targets) ─────────────────────')

  // (a) x.com signed-in verification.
  {
    const tab = await openTab(client, 'https://x.com/home')
    await settle(client, tab.sessionId, 12000)
    const url = await evaluate<string>(client, tab.sessionId, 'location.href')
    const markers = await evaluate<Record<string, boolean>>(
      client,
      tab.sessionId,
      `({
        composeBtn: !!document.querySelector('[data-testid="SideNav_NewTweet_Button"],[aria-label="Post"]'),
        accountSwitcher: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'),
        primaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
      })`,
    )
    const cookies = await client.send<{ cookies: Array<{ name: string }> }>(
      'Network.getCookies',
      { urls: ['https://x.com/'] },
      tab.sessionId,
    )
    const hasAuth = cookies.cookies.some((c) => c.name === 'auth_token')
    const onLogin = /\/login|\/i\/flow\/login/.test(url)
    const signedIn = hasAuth && !onLogin && (markers.composeBtn || markers.primaryColumn || markers.accountSwitcher)
    lines.push(`  x.com identity   : ${signedIn ? '✅ SIGNED IN' : '❌ not signed in'}  (auth_token=${hasAuth}, url=${url})`)
    await closeTab(client, tab.targetId)
  }

  // (b) External automation-tell adjudicator.
  {
    const tab = await openTab(client, 'https://bot.sannysoft.com/')
    await settle(client, tab.sessionId, 12000)
    const res = await evaluate<{ failed: number; failedNames: string[] }>(
      client,
      tab.sessionId,
      `(function(){
         var failedEls = Array.from(document.querySelectorAll('.failed, td.result.failed'));
         var names = failedEls.map(function(e){ var tr=e.closest('tr'); return tr? tr.cells[0].innerText.trim() : e.innerText.trim(); });
         return { failed: failedEls.length, failedNames: names.slice(0,12) };
       })()`,
    )
    lines.push(`  sannysoft tells  : ${res.failed === 0 ? '✅ 0 failed' : '⚠  ' + res.failed + ' failed - ' + res.failedNames.join(', ')}`)
    await closeTab(client, tab.targetId)
  }

  // (c) Cloudflare - polls ~30s to see whether a managed challenge auto-clears for a legit browser.
  {
    const url = process.env.CLOUDFLARE_URL ?? 'https://nowsecure.nl/'
    const tab = await openTab(client, url)
    await settle(client, tab.sessionId, 15000)
    let info = { title: '', body: '' }
    let verdict: 'pass' | 'gated' | 'blocked' = 'gated'
    for (let attempt = 0; attempt < 12; attempt++) {
      info = await evaluate<{ title: string; body: string }>(
        client,
        tab.sessionId,
        `({ title: document.title, body: (document.body ? document.body.innerText : '').slice(0, 600) })`,
      )
      verdict = classify(info.title, info.body)
      if (verdict !== 'gated') break
      await new Promise((r) => setTimeout(r, 2500))
    }
    const mark = verdict === 'pass' ? '✅ PASS' : verdict === 'gated' ? '⚠  GATED (→ human takeover)' : '❌ BLOCKED'
    lines.push(`  Cloudflare       : ${mark}  (${url} - "${info.title}")`)
    await closeTab(client, tab.targetId)
  }

  // (d) DataDome - needs a designated target.
  if (process.env.DATADOME_URL) {
    const url = process.env.DATADOME_URL
    const tab = await openTab(client, url)
    await settle(client, tab.sessionId, 15000)
    const info = await evaluate<{ title: string; body: string }>(
      client,
      tab.sessionId,
      `({ title: document.title, body: (document.body ? document.body.innerText : '').slice(0, 600) })`,
    )
    const verdict = classify(info.title, info.body)
    lines.push(`  DataDome         : ${verdict === 'pass' ? '✅ PASS' : verdict === 'gated' ? '⚠  GATED' : '❌ BLOCKED'}  (${url})`)
    await closeTab(client, tab.targetId)
  } else {
    lines.push('  DataDome         : ⬜ skipped - set DATADOME_URL to a designated target to measure.')
  }
}

async function main(): Promise<void> {
  const runMatrix = !!(process.env.PROFILE_DIR || process.env.CDP_URL)
  const { client, close } = await getBrowser()
  try {
    await selfCheck(client)
    if (runMatrix) await targetMatrix(client)
    else lines.push('\n(target matrix skipped - set PROFILE_DIR or CDP_URL to a signed-in Chrome to run it.)')
  } finally {
    close()
  }

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(' chromatrix · fidelity eval')
  console.log('══════════════════════════════════════════════════════════════════')
  console.log(lines.join('\n'))
  console.log('══════════════════════════════════════════════════════════════════\n')

  if (hardFailure) {
    console.error('FIDELITY CHECK FAILED - a load-bearing signal is wrong (see ❌ above).')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('fidelity eval failed:', e)
  process.exitCode = 1
})
