// S3 runner — launches one Chrome ("one identity") and runs the three concurrency scenarios, then prints a
// verdict + the concrete implications for the orchestrator. Headless by default (HEADLESS=0 to watch).
//
//   pnpm s3     # from repo root

import { launchChrome } from './launch-chrome.ts'
import { CdpClient } from './cdp-client.ts'
import { sharedContextConcurrency, navigationStomp, isolatedContexts } from './scenarios.ts'

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: process.env.HEADLESS !== '0' })
  const client = await CdpClient.connect(chrome.browserWsUrl)
  try {
    const shared = await sharedContextConcurrency(client, 5)
    const stomp = await navigationStomp(client)
    const iso = await isolatedContexts(client, 3)

    const yn = (b: boolean) => (b ? 'yes' : 'no')
    console.log('\n══════════════════════════════════════════════════════════════════════════════')
    console.log(' chromatrix · S3 — shared-tab concurrency vs isolated contexts')
    console.log('══════════════════════════════════════════════════════════════════════════════\n')

    console.log('── A) Shared context, one tab per agent (the chosen v1 model) ─────────────────')
    console.log(`  ${yn(shared.allCompleted).padEnd(4)} ${shared.agents} concurrent agents all completed without CDP error`)
    console.log(`  ${yn(shared.allSeeSharedCookie).padEnd(4)} all agents see a cookie set by one agent (shared login works)`)
    console.log(`  ${yn(shared.allPerAgentKeysPresent).padEnd(4)} every agent's localStorage write is present in a fresh tab`)
    console.log(`  ⚠   'shared' localStorage key = "${shared.sharedKeyFinalValue}" (last-writer-wins — agents racing on the SAME key clobber)`)

    console.log('\n── B) Navigation stomping: two agents forced to share ONE tab ────────────────')
    console.log(`  ${stomp.inFlightBroke ? '❌ BROKE' : '✅ survived'} — ${stomp.detail}`)
    console.log('  → an agent navigating a tab destroys another agent\'s in-flight op on that tab.')

    console.log('\n── C) Per-job isolated browser contexts (the alternative) ────────────────────')
    console.log(`  ${yn(iso.storageIsolated).padEnd(4)} localStorage isolated across ${iso.contexts} contexts (same origin)`)
    console.log(`  ${yn(iso.cookiesIsolated).padEnd(4)} cookies isolated across contexts`)
    console.log(`  ${iso.persistentLoginVisibleInEphemeral ? 'yes' : 'no '} persistent (default-context) login cookie visible inside an ephemeral context`)

    console.log('\n── Verdict / orchestrator rules ──────────────────────────────────────────────')
    const sharedOk = shared.allCompleted && shared.allSeeSharedCookie && shared.allPerAgentKeysPresent
    console.log(`  • Shared-context concurrency is ${sharedOk ? '✅ SOUND' : '❌ problematic'}: many agents drive one identity`)
    console.log('    concurrently, each in its OWN tab, all sharing the login — as designed. Two rules fall out:')
    console.log(`      1. ${stomp.inFlightBroke ? 'ENFORCE tab affinity' : '(nav is safe, but still)'} — one tab is owned by one agent at a time; never`)
    console.log('         hand a tab that is mid-operation to another agent (navigation destroys its context).')
    console.log('      2. Shared storage/cookies are last-writer-wins — agents must namespace their own keys;')
    console.log('         the orchestrator owns any cross-agent shared state, not the page.')
    if (!iso.persistentLoginVisibleInEphemeral && iso.storageIsolated) {
      console.log('  • Per-job isolated contexts DO isolate storage/cookies — but an ephemeral context does NOT')
      console.log('    inherit the identity\'s persistent login (confirmed). So they are the WRONG tool for')
      console.log('    per-job isolation under one identity unless you inject the login cookies into each context.')
      console.log('    → v1 sticks with shared context + tab affinity; reserve contexts for genuinely anonymous jobs.')
    }
    console.log('\n  Still open (not tested here): dynamic HSTS / TLS-session-cache leakage between the default')
    console.log('  context and ephemeral contexts (PRD §6 flagged unknowns) — needs a dedicated probe.')
    console.log('══════════════════════════════════════════════════════════════════════════════\n')
  } finally {
    client.close()
    chrome.close()
  }
}

main().catch((e) => {
  console.error('S3 run failed:', e)
  process.exitCode = 1
})
