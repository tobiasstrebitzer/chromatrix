// S2 target matrix — the decisive, login-dependent measurement (docs/PRD.md §7). Connects to the ALREADY
// RUNNING, logged-in Chrome from the S4 login tool (discovered via the profile's DevToolsActivePort, or
// CDP_URL env) and, in new tabs, (a) confirms the persisted x.com identity is signed in, (b) reads an
// external automation-tell adjudicator (bot.sannysoft.com), and (c) probes a Cloudflare-protected target.
// DataDome needs a designated customer target (set DATADOME_URL) — skipped otherwise.
//
//   PROFILE_DIR=./.profiles/x pnpm s2:targets      # while `pnpm s4` is running on that profile
//   CDP_URL=ws://127.0.0.1:PORT/devtools/browser/… pnpm s2:targets

import { CdpClient } from './cdp-client.ts'
import { launchChrome } from './launch-chrome.ts'

// Either connect to a running Chrome (CDP_URL) or self-launch a headed one with the persistent profile
// (PROFILE_DIR — so the x.com login is available). Headed by default for the real GPU/stealth fingerprint.
async function getBrowser(): Promise<{ client: CdpClient; close: () => void }> {
  if (process.env.CDP_URL) {
    const client = await CdpClient.connect(process.env.CDP_URL)
    return { client, close: () => client.close() }
  }
  const chrome = await launchChrome({
    headless: process.env.HEADLESS === '1',
    profileDir: process.env.PROFILE_DIR,
    startUrl: 'about:blank',
  })
  const client = await CdpClient.connect(chrome.browserWsUrl)
  return {
    client,
    close: () => {
      client.close()
      chrome.close()
    },
  }
}

interface TabHandle {
  targetId: string
  sessionId: string
}

async function openTab(client: CdpClient, url: string): Promise<TabHandle> {
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

function classify(title: string, bodyText: string): 'pass' | 'gated' | 'blocked' {
  const t = `${title}\n${bodyText}`.toLowerCase()
  if (/(sorry, you have been blocked|access denied|you don't have permission|error 1020)/.test(t)) return 'blocked'
  if (/(just a moment|checking your browser|attention required|verify you are human|enable javascript and cookies|cf-mitigated|needs to review the security)/.test(t))
    return 'gated'
  return 'pass'
}

async function main(): Promise<void> {
  const { client, close } = await getBrowser()
  console.log(`Browser ready (profile: ${process.env.PROFILE_DIR ?? 'ephemeral'})\n`)

  const lines: string[] = []
  try {
    // ── (a) x.com signed-in verification ──────────────────────────────────────────────────────────────
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
      const cookies = await client.send<{ cookies: Array<{ name: string; domain: string }> }>(
        'Network.getCookies',
        { urls: ['https://x.com/'] },
        tab.sessionId,
      )
      const hasAuth = cookies.cookies.some((c) => c.name === 'auth_token')
      const onLogin = /\/login|\/i\/flow\/login/.test(url)
      const signedIn = hasAuth && !onLogin && (markers.composeBtn || markers.primaryColumn || markers.accountSwitcher)
      lines.push(`(a) x.com identity   : ${signedIn ? '✅ SIGNED IN' : '❌ not signed in'}`)
      lines.push(`      final url      : ${url}`)
      lines.push(`      auth_token cookie: ${hasAuth}   logged-in DOM markers: ${JSON.stringify(markers)}`)
      await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
    }

    // ── (b) External automation-tell adjudicator ──────────────────────────────────────────────────────
    {
      const tab = await openTab(client, 'https://bot.sannysoft.com/')
      await settle(client, tab.sessionId, 12000)
      const res = await evaluate<{ failed: number; failedNames: string[]; total: number }>(
        client,
        tab.sessionId,
        `(function(){
           var failedEls = Array.from(document.querySelectorAll('.failed, td.result.failed'));
           var names = failedEls.map(function(e){ var tr=e.closest('tr'); return tr? tr.cells[0].innerText.trim() : e.innerText.trim(); });
           return { failed: failedEls.length, failedNames: names.slice(0,12), total: document.querySelectorAll('table tr').length };
         })()`,
      )
      lines.push('')
      lines.push(`(b) sannysoft tells  : ${res.failed === 0 ? '✅ 0 failed' : '⚠  ' + res.failed + ' failed'}`)
      if (res.failed) lines.push(`      failed        : ${res.failedNames.join(', ')}`)
      await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
    }

    // ── (c) Cloudflare-protected target (polls for a managed challenge to auto-clear) ───────────────────
    {
      const url = process.env.CLOUDFLARE_URL ?? 'https://nowsecure.nl/'
      const tab = await openTab(client, url)
      await settle(client, tab.sessionId, 15000)
      // A managed challenge shows "Just a moment…" then may auto-solve for a legit browser — poll ~30s.
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
      lines.push('')
      lines.push(`(c) Cloudflare (${url})`)
      lines.push(
        `      verdict       : ${verdict === 'pass' ? '✅ PASS (challenge auto-cleared)' : verdict === 'gated' ? '⚠  GATED (challenge persisted ~45s)' : '❌ BLOCKED'}`,
      )
      lines.push(`      title         : ${info.title}`)
      await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
    }

    // ── (d) DataDome (needs a designated target) ──────────────────────────────────────────────────────
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
      lines.push('')
      lines.push(`(d) DataDome (${url})`)
      lines.push(`      verdict       : ${verdict === 'pass' ? '✅ PASS' : verdict === 'gated' ? '⚠  GATED' : '❌ BLOCKED'}`)
      await client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
    } else {
      lines.push('')
      lines.push('(d) DataDome         : skipped — set DATADOME_URL to a designated target to measure.')
    }
  } finally {
    close()
  }

  console.log('══════════════════════════════════════════════════════════════════════════════')
  console.log(' chromatrix · S2 target matrix (logged-in, real targets)')
  console.log('══════════════════════════════════════════════════════════════════════════════\n')
  console.log(lines.join('\n'))
  console.log('\n══════════════════════════════════════════════════════════════════════════════\n')
}

main().catch((e) => {
  console.error('S2 target matrix failed:', e)
  process.exitCode = 1
})
