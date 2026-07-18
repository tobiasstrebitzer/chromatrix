// S1 runner. Launches one real headed Chrome, then for each interceptor (transparent vs mitigating):
//   - drives the naive raw-CDP consumer through the mux,
//   - records whether `Runtime.enable` actually reached Chrome (the mux's ground-truth counter) — the
//     protocol-level claim that matters on current Chrome,
//   - runs the legacy getter-trap probe (informational: closed on Chrome 150+, see README/diag2).
// Also runs a 2-consumer multiplex smoke check. Prints a verdict.
//
//   pnpm s1                 # from repo root
//   HEADLESS=1 pnpm s1      # headless; identical protocol behaviour, no visible window

import { CdpMux, transparentInterceptor, type Interceptor } from '@chromatrix/cdp'
import { launchChrome, runtimeEnableSuppressInterceptor } from '@chromatrix/fidelity'
import { runConsumer } from './consumer.ts'
import { runProbe, closeTarget } from './probe.ts'

interface Row {
  mode: string
  interceptor: string
  evaluateOk: boolean
  gotContext: boolean
  runtimeEnableReachedChrome: boolean
  legacyGetterLeak: boolean
  consumerError?: string
}

async function measure(browserWsUrl: string, mode: string, interceptor: Interceptor): Promise<Row> {
  const mux = await CdpMux.start({ browserWsUrl, interceptor })
  try {
    const { result: consumer, close: closeConsumer } = await runConsumer(mux.url!)
    const probe = await runProbe(browserWsUrl, consumer.targetId) // measured while consumer session is live
    const runtimeEnableReachedChrome = mux.forwardedMethods.has('Runtime.enable')
    closeConsumer()
    await closeTarget(browserWsUrl, consumer.targetId)
    return {
      mode,
      interceptor: interceptor.name,
      evaluateOk: consumer.evaluateOk,
      gotContext: consumer.gotExecutionContext,
      runtimeEnableReachedChrome,
      legacyGetterLeak: probe.leakDetected,
      consumerError: consumer.error,
    }
  } finally {
    mux.close()
  }
}

async function multiplexSmoke(browserWsUrl: string): Promise<{ ok: boolean; detail: string }> {
  const mux = await CdpMux.start({ browserWsUrl, interceptor: runtimeEnableSuppressInterceptor })
  try {
    const [a, b] = await Promise.all([runConsumer(mux.url!), runConsumer(mux.url!)])
    const ok = a.result.evaluateOk && b.result.evaluateOk && a.result.targetId !== b.result.targetId
    a.close()
    b.close()
    await Promise.all([closeTarget(browserWsUrl, a.result.targetId), closeTarget(browserWsUrl, b.result.targetId)])
    return { ok, detail: `two consumers, distinct tabs, both evaluated: ${ok}` }
  } finally {
    mux.close()
  }
}

function printReport(rows: Row[], smoke: { ok: boolean; detail: string }): void {
  const yn = (b: boolean) => (b ? 'yes' : 'no')
  console.log('\n══════════════════════════════════════════════════════════════════════════════')
  console.log(' chromatrix · S1 — mitigating CDP mux')
  console.log('══════════════════════════════════════════════════════════════════════════════\n')
  const cols = ['interceptor', 'consumer eval ok', 'got ctx', 'Runtime.enable→Chrome', 'legacy getter-leak']
  console.log(cols.map((s) => s.padEnd(24)).join(''))
  console.log('─'.repeat(120))
  for (const r of rows) {
    console.log(
      [
        r.interceptor,
        yn(r.evaluateOk),
        yn(r.gotContext),
        r.runtimeEnableReachedChrome ? 'YES (reached)' : 'no (blocked)',
        r.legacyGetterLeak ? 'DETECTED' : 'not present',
      ]
        .map((s) => String(s).padEnd(24))
        .join(''),
    )
    if (r.consumerError) console.log(`   consumer error: ${r.consumerError}`)
  }
  console.log('\nMultiplex smoke:', smoke.ok ? 'PASS' : 'FAIL', '—', smoke.detail)

  const baseline = rows.find((r) => r.interceptor === 'transparent')
  const mitigated = rows.find((r) => r.interceptor === 'runtime-enable-suppress')

  console.log('\n── Findings ──────────────────────────────────────────────────────────────────')
  // 1) Legacy in-page leak status on this Chrome build.
  if (baseline && !baseline.legacyGetterLeak) {
    console.log('• Legacy getter-trap leak: NOT present on this Chrome build (150) even under a transparent')
    console.log('  proxy with Runtime.enable active — Chrome now serializes accessors as {type:"accessor"}')
    console.log('  without invoking them (see src/diag2.ts). The classic in-page CDP tell is closed here.')
  } else if (baseline && baseline.legacyGetterLeak) {
    console.log('• Legacy getter-trap leak: ACTIVE under transparent proxy on this build.')
  }

  // 2) Protocol-level mitigation (the claim that still matters on current Chrome).
  console.log('')
  const sanity = baseline?.runtimeEnableReachedChrome === true && baseline?.evaluateOk === true
  if (!sanity) {
    console.log('⚠  Harness sanity check failed: transparent baseline should forward Runtime.enable AND')
    console.log('   evaluate. Inspect the table before trusting the mitigated row.')
  } else if (mitigated && !mitigated.runtimeEnableReachedChrome && mitigated.evaluateOk) {
    console.log('✅ S1 PROTOCOL CLAIM PROVEN: the mux prevented Runtime.enable from EVER reaching Chrome for')
    console.log('   an unmodified raw-CDP consumer, yet that consumer still received an execution context and')
    console.log('   evaluated JS (via a synthesized isolated world). Handshake surface reduced with no loss of')
    console.log('   consumer functionality — defense-in-depth against older builds + non-getter CDP tells.')
  } else if (mitigated && !mitigated.evaluateOk) {
    console.log('❌ PIVOT SIGNAL: suppression broke the consumer (eval failed) → proxy-side rewriting is not')
    console.log('   transparent for this consumer. Favour "fidelity-lint / reject-and-upgrade" (PRD §7 S1).')
  } else if (mitigated && mitigated.runtimeEnableReachedChrome) {
    console.log('❌ Mitigation did not block Runtime.enable — it still reached Chrome. Interceptor bug.')
  }
  console.log('──────────────────────────────────────────────────────────────────────────────\n')
}

async function main(): Promise<void> {
  const chrome = await launchChrome({ headless: process.env.HEADLESS === '1' })
  console.log(`Chrome up: ${chrome.browserWsUrl}`)
  try {
    const rows: Row[] = []
    rows.push(await measure(chrome.browserWsUrl, 'baseline', transparentInterceptor))
    rows.push(await measure(chrome.browserWsUrl, 'mitigated', runtimeEnableSuppressInterceptor))
    const smoke = await multiplexSmoke(chrome.browserWsUrl)
    printReport(rows, smoke)
  } finally {
    chrome.close()
  }
}

main().catch((e) => {
  console.error('S1 run failed:', e)
  process.exitCode = 1
})
