// End-to-end acceptance test (NEXT-SESSION §"the end-to-end acceptance test"). Boots the REAL gateway on an
// ephemeral port against a throwaway profiles root, provisions an identity + a real headed Chrome, allocates
// a tab for agent A and agent B over the HTTP provisioning surface, then connects a RAW CdpClient to A's
// scoped URL and asserts:
//   1. A can attach to its own tab and evaluate JS in it,
//   2. A's Target.getTargets is filtered to only A's tab (B's is invisible),
//   3. A CANNOT attach to B's target — the mux returns "not in this client's scope",
//   4. a bad/absent token is refused at the upgrade,
//   5. the global access token gates REST + MCP + the takeover WS, and cookie login works for the dashboard.
// This exercises core → mux ACL → the raw-WS upgrade path → the mitigating interceptor together.
//
//   pnpm --filter @chromatrix/gateway run accept        # headed
//   HEADLESS=1 pnpm --filter @chromatrix/gateway run accept

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
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
  const { startGateway } = await import('../bootstrap.ts')
  // An explicit token, so the run neither reads nor writes the developer's real ~/.config/chromatrix.
  const accessToken = 'test-access-token-acceptance'
  const handle = await startGateway({ port: 0, accessToken })
  const base = `http://${handle.host}:${handle.port}/api`
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
    return res.json()
  }

  let clientA: CdpClient | undefined
  try {
    console.log(`\nchromatrix · gateway acceptance (profiles: ${profiles})\n`)

    // (5) The access-token perimeter. Every management surface must refuse an unauthenticated caller — this
    // is the check that fails loudly if a future route ships outside the global guard.
    const raw = (path: string, headers: Record<string, string> = {}) =>
      fetch(`http://${handle.host}:${handle.port}${path}`, { headers })
    const noToken = await raw('/api/sessions')
    const badToken = await raw('/api/sessions', { authorization: 'Bearer wrong-token' })
    const goodToken = await raw('/api/sessions', { authorization: `Bearer ${accessToken}` })
    check(
      'REST refuses missing + wrong token, accepts the real one',
      noToken.status === 401 && badToken.status === 401 && goodToken.status === 200,
      `${noToken.status} / ${badToken.status} / ${goodToken.status}`,
    )

    // MCP is gated at the TRANSPORT, so even tool *discovery* is closed — a per-method guard would leave the
    // catalogue readable, since tools/list has no controller method behind it.
    const mcpList = await fetch(`http://${handle.host}:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    check('MCP tools/list closed to anonymous callers', mcpList.status === 401, `${mcpList.status}`)

    // The dashboard's path: trade the token for a cookie, then authenticate with the cookie alone. This is
    // what makes <img src> screenshots and the takeover WebSocket work in a browser, neither of which can
    // set an Authorization header.
    const login = await fetch(`http://${handle.host}:${handle.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: accessToken }),
    })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('chromatrix_token='))
    const viaCookie = await raw('/api/sessions', { cookie: cookie?.split(';')[0] ?? '' })
    check(
      'cookie login works and the cookie is HttpOnly',
      login.status === 201 && viaCookie.status === 200 && (cookie?.includes('HttpOnly') ?? false),
      `login ${login.status}, cookie-auth ${viaCookie.status}`,
    )

    const badLogin = await fetch(`http://${handle.host}:${handle.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-the-token' }),
    })
    check('login rejects a wrong token', badLogin.status === 401, `${badLogin.status}`)

    // The takeover socket is an operator surface (live view + trusted input), and it lives OUTSIDE Nest — a
    // guard cannot reach it, because WS handshakes arrive on `upgrade`, not `request`. So it carries its own
    // check, and this asserts it: without a token the upgrade is refused before the socket is accepted.
    const takeoverErr = await expectReject(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${handle.host}:${handle.port}/takeover/${IDENTITY}/ws`)
        ws.on('open', () => (ws.close(), resolve(undefined)))
        ws.on('error', reject)
      }),
    )
    check('takeover WS refuses an unauthenticated upgrade', takeoverErr !== undefined, takeoverErr ?? 'connected (should not)')

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
