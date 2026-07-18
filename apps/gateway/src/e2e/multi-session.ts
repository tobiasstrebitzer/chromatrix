// Multi-session parallel e2e (NEXT-SESSION §"multi-session parallel e2e test"). Scales the single-identity
// acceptance test into the load shape the platform exists for: several identities (each its own real Chrome)
// running concurrently, each driven by multiple agents doing real work in parallel. It proves, together and
// under load: (a) tab work runs concurrently, not serialized (S3 shared-context + tab-affinity), (b) the live
// per-tab ACL isolates agents both within an identity and across identities, (c) releasing a tab shrinks its
// agent's scope immediately, and (d) shutdown reaps every Chrome in the fleet.
//
//   pnpm --filter @chromatrix/gateway run e2e                                  # headless (default), 2×2×1
//   IDENTITIES=3 AGENTS_PER_IDENTITY=3 TABS_PER_AGENT=2 HEADLESS=0 pnpm … run e2e
//
// Fleet size is env-configurable but small by default: a real headed Chrome is ~1.5–2 GB per identity (S2),
// so don't casually crank IDENTITIES on a laptop.

import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { CdpClient } from '@chromatrix/cdp'
import { findChromePidsForProfile } from '@chromatrix/core'

// ── config ───────────────────────────────────────────────────────────────────────────────────────────────
const IDENTITIES = envInt('IDENTITIES', 2)
const AGENTS_PER_IDENTITY = envInt('AGENTS_PER_IDENTITY', 2)
const TABS_PER_AGENT = envInt('TABS_PER_AGENT', 1)
const HEADLESS = process.env.HEADLESS !== '0' // headless by default; HEADLESS=0 to watch the fleet

function envInt(name: string, dflt: number): number {
  const v = process.env[name]
  const n = v === undefined ? dflt : Number(v)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${v}"`)
  return n
}

// ── check harness ────────────────────────────────────────────────────────────────────────────────────────
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function attachErr(client: CdpClient, targetId: string): Promise<string | undefined> {
  try {
    await client.send('Target.attachToTarget', { targetId, flatten: true })
    return undefined
  } catch (e) {
    return (e as Error).message
  }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── hermetic target page (unique per-tab marker echoed from the query string) ────────────────────────────
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body>
<div id="marker"></div>
<script>
  var m = new URLSearchParams(location.search).get('m') || '';
  document.getElementById('marker').textContent = m;
  document.title = m;
</script></body></html>`

function startPageServer(): Promise<{ pageUrl: (marker: string) => string; close: () => void }> {
  return new Promise((resolve) => {
    const server: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        pageUrl: (marker) => `http://127.0.0.1:${port}/p?m=${encodeURIComponent(marker)}`,
        close: () => server.close(),
      })
    })
  })
}

// ── model ────────────────────────────────────────────────────────────────────────────────────────────────
interface TabWork {
  targetId: string
  marker: string
}
interface AgentWork {
  identity: string
  agentId: string
  cdpUrl: string
  tabs: TabWork[]
}
interface AgentRuntime {
  work: AgentWork
  client: CdpClient
  durationMs: number
  sessionByTarget: Map<string, string>
  gotMarkers: Map<string, string>
}

async function main(): Promise<void> {
  const profiles = mkdtempSync(join(tmpdir(), 'chromatrix-e2e-'))
  process.env.CHROMATRIX_PROFILES = profiles
  const { startGateway } = await import('../bootstrap.ts')
  const page = await startPageServer()
  const handle = await startGateway({ port: 0 })
  const base = `http://${handle.host}:${handle.port}/api`
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    return res.json()
  }

  const totalTabs = IDENTITIES * AGENTS_PER_IDENTITY * TABS_PER_AGENT
  console.log(`\nchromatrix · gateway multi-session e2e`)
  console.log(
    `  fleet: ${IDENTITIES} identities × ${AGENTS_PER_IDENTITY} agents × ${TABS_PER_AGENT} tab(s) = ` +
      `${IDENTITIES} Chrome, ${totalTabs} tabs${HEADLESS ? ' (headless)' : ' (headed)'}`,
  )
  console.log(`  profiles: ${profiles}\n`)

  const runtimes: AgentRuntime[] = []
  try {
    // 1. Provision the fleet: one Chrome per identity, then a tab per (agent, tab) leased on about:blank.
    const fleet: AgentWork[] = []
    for (let i = 0; i < IDENTITIES; i++) {
      const identity = `e2e-${i}`
      await post('/identity', { id: identity })
      await post('/identity/start', { id: identity, headless: HEADLESS })
      for (let a = 0; a < AGENTS_PER_IDENTITY; a++) {
        const agentId = `${identity}-agent-${a}`
        const tabs: TabWork[] = []
        let cdpUrl = ''
        for (let t = 0; t < TABS_PER_AGENT; t++) {
          const marker = `${agentId}__tab${t}`
          const lease = (await post('/tab/allocate', { identity, agentId, url: 'about:blank' })) as {
            targetId: string
            cdpUrl: string
          }
          tabs.push({ targetId: lease.targetId, marker })
          cdpUrl ||= lease.cdpUrl // any of an agent's tokens resolves to the same live scope
        }
        fleet.push({ identity, agentId, cdpUrl, tabs })
      }
    }
    check('provisioned fleet', fleet.length === IDENTITIES * AGENTS_PER_IDENTITY, `${fleet.length} agents, ${totalTabs} tabs`)

    // 2+3. Parallel work: every agent concurrently connects, navigates each of its tabs to a uniquely-marked
    // page, and reads the marker back. Isolation means each agent sees ONLY its own marker.
    const t0 = performance.now()
    const settled = await Promise.all(
      fleet.map(async (work): Promise<AgentRuntime> => {
        const start = performance.now()
        const client = await CdpClient.connect(work.cdpUrl)
        const sessionByTarget = new Map<string, string>()
        const gotMarkers = new Map<string, string>()
        for (const tab of work.tabs) {
          const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId: tab.targetId,
            flatten: true,
          })
          sessionByTarget.set(tab.targetId, sessionId)
          await client.send('Page.enable', {}, sessionId)
          const loaded = client.once('Page.loadEventFired', { sessionId, timeoutMs: 20_000 })
          await client.send('Page.navigate', { url: page.pageUrl(tab.marker) }, sessionId)
          await loaded
          const res = await client.send<{ result: { value?: string } }>(
            'Runtime.evaluate',
            { expression: "document.getElementById('marker').textContent", returnByValue: true },
            sessionId,
          )
          gotMarkers.set(tab.targetId, res.result?.value ?? '')
        }
        return { work, client, durationMs: performance.now() - start, sessionByTarget, gotMarkers }
      }),
    )
    const wallMs = performance.now() - t0
    runtimes.push(...settled)

    // Every tab read back exactly its own marker (no cross-talk between concurrent sessions).
    let mismatches = 0
    for (const rt of runtimes) for (const tab of rt.work.tabs) if (rt.gotMarkers.get(tab.targetId) !== tab.marker) mismatches++
    check('every agent read back its own marker', mismatches === 0, `${totalTabs - mismatches}/${totalTabs} tabs correct`)

    // Concurrency: wall-clock is well under the sum of per-agent durations → work truly overlapped.
    const sumMs = runtimes.reduce((s, r) => s + r.durationMs, 0)
    const ratio = sumMs > 0 ? wallMs / sumMs : 1
    if (fleet.length >= 2) {
      check('work ran in parallel, not serialized', ratio < 0.9, `wall ${wallMs.toFixed(0)}ms vs sum ${sumMs.toFixed(0)}ms (ratio ${ratio.toFixed(2)})`)
    }

    // 4. Isolation matrix. getTargets is filtered to each agent's own tabs; peers (same identity) and
    // foreign identities are unreachable.
    let leaky = 0
    for (const rt of runtimes) {
      const { targetInfos } = await rt.client.send<{ targetInfos: Array<{ targetId: string }> }>('Target.getTargets')
      const seen = new Set(targetInfos.map((t) => t.targetId))
      const own = new Set(rt.work.tabs.map((t) => t.targetId))
      if (seen.size !== own.size || [...seen].some((id) => !own.has(id))) leaky++
    }
    check('getTargets is ACL-filtered to each agent’s own tabs', leaky === 0, `${runtimes.length - leaky}/${runtimes.length} agents clean`)

    const peer = pickPeerSameIdentity(runtimes)
    if (peer) {
      const err = await attachErr(peer.a.client, peer.b.work.tabs[0].targetId)
      check('agent cannot attach to a PEER agent’s tab (same identity)', err !== undefined && /scope/i.test(err), err ?? 'attached (should not)')
    }

    const cross = pickCrossIdentity(runtimes)
    if (cross) {
      const err = await attachErr(cross.a.client, cross.b.work.tabs[0].targetId)
      check('agent cannot attach to a FOREIGN identity’s tab', err !== undefined && /scope/i.test(err), err ?? 'attached (should not)')
    }

    // 5. Churn: release one agent's first tab and assert its scope shrinks live (re-attach denied), while a
    // different agent is unaffected.
    const victim = runtimes[0]
    const victimTarget = victim.work.tabs[0].targetId
    await post('/tab/release', { identity: victim.work.identity, targetId: victimTarget })
    await delay(150)
    const churnErr = await attachErr(victim.client, victimTarget)
    check('released tab is denied to its own agent immediately', churnErr !== undefined && /scope/i.test(churnErr), churnErr ?? 'attached (should not)')
    const bystander = runtimes.find((r) => r !== victim)
    if (bystander) {
      const bErr = await attachErr(bystander.client, bystander.work.tabs[0].targetId)
      check('a bystander agent is unaffected by the release', bErr === undefined, bErr ? `denied: ${bErr}` : 're-attached ok')
    }
  } finally {
    for (const rt of runtimes) rt.client.close()
    page.close()
    await handle.close().catch(() => {})
  }

  // 6. Teardown proof: SIGTERM'd every Chrome — none may remain bound to the tmp profiles. Poll briefly since
  // SIGTERM → exit is async.
  let survivors = (await findChromePidsForProfile(profiles)).length
  for (let i = 0; i < 20 && survivors > 0; i++) {
    await delay(250)
    survivors = (await findChromePidsForProfile(profiles)).length
  }
  check('no Chrome left bound to the fleet after shutdown', survivors === 0, `${survivors} survivor(s)`)
  rmSync(profiles, { recursive: true, force: true })

  const passed = results.every((r) => r.ok)
  console.log(`\n${passed ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.ok).length}/${results.length} checks\n`)
  process.exitCode = passed ? 0 : 1
}

/** Two agents that share an identity (for the same-identity isolation check), or undefined if none. */
function pickPeerSameIdentity(rts: AgentRuntime[]): { a: AgentRuntime; b: AgentRuntime } | undefined {
  for (const a of rts) {
    const b = rts.find((r) => r !== a && r.work.identity === a.work.identity)
    if (b) return { a, b }
  }
  return undefined
}

/** Two agents in different identities (for the cross-identity isolation check), or undefined if only one. */
function pickCrossIdentity(rts: AgentRuntime[]): { a: AgentRuntime; b: AgentRuntime } | undefined {
  for (const a of rts) {
    const b = rts.find((r) => r.work.identity !== a.work.identity)
    if (b) return { a, b }
  }
  return undefined
}

main().catch((e) => {
  console.error('\nmulti-session e2e errored:', e)
  process.exitCode = 1
})
