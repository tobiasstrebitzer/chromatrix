// End-to-end acceptance test (NEXT-SESSION §"the end-to-end acceptance test"). Boots the REAL gateway on an
// ephemeral port against a throwaway profiles root, provisions an identity + a real headed Chrome, allocates
// a tab for agent A and agent B over the HTTP provisioning surface, then connects a RAW CdpClient to A's
// scoped URL and asserts:
//   1. A can attach to its own tab and evaluate JS in it,
//   2. A's Target.getTargets is filtered to only A's tab (B's is invisible),
//   3. A CANNOT attach to B's target — the mux returns "not in this client's scope",
//   4. a bad/absent token is refused at the upgrade.
// This exercises core → mux ACL → the raw-WS upgrade path → the mitigating interceptor together.
//
//   pnpm --filter @chromatrix/gateway run accept        # headed
//   HEADLESS=1 pnpm --filter @chromatrix/gateway run accept

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CdpClient } from '@chromatrix/cdp'

const IDENTITY = 'accept'
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function expectReject(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (e) {
    return (e as Error).message
  }
}

async function main(): Promise<void> {
  const profiles = mkdtempSync(join(tmpdir(), 'chromatrix-accept-'))
  process.env.CHROMATRIX_PROFILES = profiles
  const { startGateway } = await import('./bootstrap.ts')
  const handle = await startGateway({ port: 0 })
  const base = `http://${handle.host}:${handle.port}`
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    return res.json()
  }

  let clientA: CdpClient | undefined
  try {
    console.log(`\nchromatrix · gateway acceptance (profiles: ${profiles})\n`)
    await post('/identity', { id: IDENTITY })
    await post('/identity/start', { id: IDENTITY, headless: process.env.HEADLESS === '1' })

    const tabA = (await post('/tab/allocate', { identity: IDENTITY, agentId: 'agent-A', url: 'about:blank' })) as {
      targetId: string
      cdpUrl: string
    }
    const tabB = (await post('/tab/allocate', { identity: IDENTITY, agentId: 'agent-B', url: 'about:blank' })) as {
      targetId: string
      cdpUrl: string
    }
    check('allocated distinct tabs for A and B', tabA.targetId !== tabB.targetId, `${tabA.targetId.slice(0, 8)} ≠ ${tabB.targetId.slice(0, 8)}`)

    // (4) A bad token must be refused at the upgrade before any mux attach.
    const badUrl = tabA.cdpUrl.replace(/token=.*/, 'token=deadbeef')
    const badErr = await expectReject(CdpClient.connect(badUrl))
    check('bad token refused at upgrade', badErr !== undefined, badErr ?? 'connected (should not)')

    // Connect agent A's raw CDP client on its scoped URL.
    clientA = await CdpClient.connect(tabA.cdpUrl)

    // (1) A attaches to its own tab + evaluates JS there.
    const attachA = (await clientA.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tabA.targetId, flatten: true }))
    const evalRes = (await clientA.send<{ result: { value: number } }>(
      'Runtime.evaluate',
      { expression: '6 * 7', returnByValue: true },
      attachA.sessionId,
    ))
    check('A evaluates JS in its own tab', evalRes.result?.value === 42, `6*7 = ${evalRes.result?.value}`)

    // (2) getTargets is ACL-filtered to A's own tab only.
    const { targetInfos } = await clientA.send<{ targetInfos: Array<{ targetId: string }> }>('Target.getTargets')
    const ids = targetInfos.map((t) => t.targetId)
    check(
      'A.getTargets excludes B’s tab',
      ids.includes(tabA.targetId) && !ids.includes(tabB.targetId),
      `sees ${ids.length} target(s)`,
    )

    // (3) A cannot attach to B's target — the core assertion.
    const denyErr = await expectReject(clientA.send('Target.attachToTarget', { targetId: tabB.targetId, flatten: true }))
    check("A cannot attach to B’s target", denyErr !== undefined && /scope/i.test(denyErr), denyErr ?? 'attached (should not)')
  } finally {
    clientA?.close()
    await handle.close().catch(() => {})
    rmSync(profiles, { recursive: true, force: true })
  }

  const passed = results.every((r) => r.ok)
  console.log(`\n${passed ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.ok).length}/${results.length} checks\n`)
  process.exitCode = passed ? 0 : 1
}

main().catch((e) => {
  console.error('\nacceptance test errored:', e)
  process.exitCode = 1
})
