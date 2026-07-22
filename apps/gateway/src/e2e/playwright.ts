// Playwright-through-the-mux regression harness. Written BEFORE the mux fix, deliberately: `accept` and
// `e2e` both drive a bare CdpClient, which speaks the protocol the way agent-browser does (queries, explicit
// attach) and therefore stays green through exactly the bug this file exists to catch.
//
//   pnpm --filter @chromatrix/gateway run pw            # headless (default)
//   HEADLESS=0 pnpm --filter @chromatrix/gateway run pw # watch it
//   TRACE=1  pnpm --filter @chromatrix/gateway run pw   # log every CDP frame of the connect handshake
//
// WHY PLAYWRIGHT AND NOT PUPPETEER: puppeteer is an explicit non-goal. Its connect handshake asks for
// browser-level auto-attach with page targets EXCLUDED (`filter:[{type:"page",exclude:true},{}]`) and then
// builds its page registry purely from attach events, so a scoped mux would have to emulate the browser's
// whole auto-attach lifecycle to satisfy it. Playwright is what our real consumer (services/gtm) uses.
//
// The shape under test is services/gtm's, not a synthetic one - `packages/core/src/cdp.ts` there does
// `chromium.connectOverCDP(url)` → `browser.contexts()[0]` → `ctx.pages()[0] ?? ctx.newPage()` → drive →
// `browser.close()` (detach, NOT kill). Every check below is one link in that chain, so a pass here means
// gtm can point at a chromatrix `cdpUrl` and keep its code.

import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

const HEADLESS = process.env.HEADLESS !== '0'
const TRACE = process.env.TRACE === '1'
// Every step is time-boxed: the failure mode this harness hunts is a HANG (a client waiting forever for a
// replay that never comes), and a hang that fails the run in 15s is worth far more than one that wedges CI.
const STEP_MS = Number(process.env.STEP_MS ?? 15_000)

// ── check harness ────────────────────────────────────────────────────────────────────────────────────────
const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` - ${detail}` : ''}`)
}

/** Run one harness step under a deadline, recording pass/fail/hang instead of throwing out of the run. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${STEP_MS}ms (hang)`)), STEP_MS)
      }),
    ])
    check(name, true)
    return value
  } catch (e) {
    check(name, false, (e as Error).message.split('\n')[0])
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Assert a value-producing step, so a check reads as its assertion rather than "it didn't throw". */
async function expect<T>(name: string, fn: () => Promise<T>, pred: (v: T) => boolean, describe: (v: T) => string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out after ${STEP_MS}ms (hang)`)), STEP_MS)
      }),
    ])
    check(name, pred(value), describe(value))
    return value
  } catch (e) {
    check(name, false, (e as Error).message.split('\n')[0])
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── hermetic target page (unique per-tab marker echoed from the query string) ────────────────────────────
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title></title></head><body>
<h1 id="marker"></h1>
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

// ── TRACE=1 relay ────────────────────────────────────────────────────────────────────────────────────────
// A logging pass-through between Playwright and the gateway. The whole bug class here is "which frames does
// the client send, and which does it never get back", and that question is only answerable on the wire - the
// previous (reverted) fix attempt was diagnosed exactly this way. Off by default; adds a hop when on.
interface Relay {
  url: string
  close: () => void
}
async function startTraceRelay(upstreamUrl: string): Promise<Relay> {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as AddressInfo).port
  wss.on('connection', (down) => {
    const up = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
    const queue: string[] = []
    up.on('open', () => {
      for (const q of queue) up.send(q)
      queue.length = 0
    })
    down.on('message', (d) => {
      const raw = d.toString()
      console.log(`  → ${trim(raw)}`)
      if (up.readyState === WebSocket.OPEN) up.send(raw)
      else queue.push(raw)
    })
    up.on('message', (d) => {
      const raw = d.toString()
      console.log(`  ← ${trim(raw)}`)
      if (down.readyState === WebSocket.OPEN) down.send(raw)
    })
    const bye = () => {
      up.close()
      down.close()
    }
    down.on('close', bye)
    up.on('close', bye)
    down.on('error', bye)
    up.on('error', bye)
  })
  return { url: `ws://127.0.0.1:${port}/`, close: () => wss.close() }
}

/** One-line frame for the trace log - screencast/screenshot payloads would otherwise flood it. */
function trim(raw: string): string {
  return raw.length > 300 ? `${raw.slice(0, 300)}… (${raw.length}b)` : raw
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Agent {
  identity: string
  agentId: string
  cdpUrl: string
  targetId: string
}

async function main(): Promise<void> {
  const profiles = mkdtempSync(join(tmpdir(), 'chromatrix-pw-'))
  process.env.CHROMATRIX_PROFILES = profiles
  const { startGateway } = await import('../bootstrap.ts')
  const page = await startPageServer()
  const accessToken = 'test-access-token-playwright'
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

  console.log(`\nchromatrix · playwright-through-the-mux`)
  console.log(`  ${HEADLESS ? 'headless' : 'headed'}${TRACE ? ' · TRACE on' : ''} · step deadline ${STEP_MS}ms`)
  console.log(`  profiles: ${profiles}\n`)

  const identity = 'pw'
  const open: Browser[] = []
  const relays: Relay[] = []
  try {
    await post('/identity', { id: identity })
    await post('/identity/start', { id: identity, headless: HEADLESS })

    // Two agents on ONE identity - the concurrency shape the platform exists for, and the one that makes the
    // ACL checks below meaningful (a peer tab that really exists, in the same Chrome, behind the same mux).
    const agents: Agent[] = []
    for (const agentId of ['pw-a', 'pw-b']) {
      // compat: Playwright drives the Runtime execution-context lifecycle, so it asks for the unmitigated
      // protocol (see InterceptContext.compat). The minted cdpUrl carries the flag; nothing is rebuilt here.
      const lease = (await post('/tab/allocate', { identity, agentId, url: 'about:blank', compat: true })) as {
        targetId: string
        cdpUrl: string
      }
      agents.push({ identity, agentId, cdpUrl: lease.cdpUrl, targetId: lease.targetId })
    }
    // The minted cdpUrl points at CHROMATRIX_PUBLIC_ORIGIN when set; in-process it is the loopback gateway,
    // which is what we want to drive here.
    const [a, b] = agents

    let urlA = a.cdpUrl
    if (TRACE) {
      const relay = await startTraceRelay(a.cdpUrl)
      relays.push(relay)
      urlA = relay.url
      console.log(`  trace relay ${relay.url} → ${a.cdpUrl}\n`)
    }

    // 1. Connect. Playwright's connectOverCDP handshake is where the target state machine gets built; if the
    //    mux can't satisfy it, everything downstream is already lost even though this call itself resolves.
    const browserA = await step('connectOverCDP attaches', () => chromium.connectOverCDP(urlA))
    if (!browserA) return finish()
    open.push(browserA)

    // 2. gtm's firstContext(): a connectOverCDP browser must expose the real, logged-in context. Zero
    //    contexts is the puppeteer-style failure - connected, but nothing to drive.
    const ctxA = await expect(
      'browser.contexts() exposes the existing context',
      async () => browserA.contexts(),
      (c) => c.length >= 1,
      (c) => `${c.length} context(s)`,
    )
    if (!ctxA?.length) return finish()
    const contextA: BrowserContext = ctxA[0]

    // 3. The leased tab must surface as a Page. This is the check that fails today: the mux answers
    //    Target.getTargets (a query) but never replays Target.targetCreated for setDiscoverTargets, and
    //    Playwright builds its page registry from the replay.
    const pagesA = await expect(
      'context.pages() lists exactly the leased tab',
      async () => contextA.pages(),
      (p) => p.length === 1,
      (p) => `${p.length} page(s): ${p.map((x) => x.url()).join(', ') || '-'}`,
    )

    // 4-7. Drive the leased page the way gtm does. `goto` reportedly succeeded even while `textContent`
    //      hung, so these are separate checks on purpose - a green goto is not evidence of a working session.
    const markerA = 'pw-a__leased'
    let pageA: Page | undefined = pagesA?.[0]
    if (pageA) {
      await step('page.goto navigates the leased tab', () => pageA!.goto(page.pageUrl(markerA), { waitUntil: 'domcontentloaded', timeout: STEP_MS }))
      await expect('page.title() resolves', () => pageA!.title(), (t) => t === markerA, (t) => `"${t}"`)
      await expect(
        'page.textContent() resolves',
        () => pageA!.textContent('#marker', { timeout: STEP_MS }),
        (t) => t === markerA,
        (t) => `"${t}"`,
      )
      // The string form, not a closure: this file typechecks under the gateway's Node lib, which has no DOM.
      await expect('page.evaluate() round-trips', () => pageA!.evaluate<string>('document.title'), (t) => t === markerA, (t) => `"${t}"`)
    } else {
      check('page.goto navigates the leased tab', false, 'no page to drive')
    }

    // 8-10. ctx.newPage() - gtm's redditProbe and the `pages()[0] ?? newPage()` fallback both depend on it.
    //       A page Playwright creates itself must be leased to THIS agent, or the ACL hides the target it
    //       just made and the whole call is a black hole.
    const markerNew = 'pw-a__newpage'
    const newPage = await step('context.newPage() opens a second tab', () => contextA.newPage())
    if (newPage) {
      await step('newPage navigates', () => newPage.goto(page.pageUrl(markerNew), { waitUntil: 'domcontentloaded', timeout: STEP_MS }))
      await expect(
        'newPage is driveable (textContent)',
        () => newPage.textContent('#marker', { timeout: STEP_MS }),
        (t) => t === markerNew,
        (t) => `"${t}"`,
      )
      await expect(
        'the gateway leased the Playwright-created tab to its agent',
        async () => {
          const res = await fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${accessToken}` } })
          const { sessions } = (await res.json()) as { sessions: Array<{ identity: string; leases: Array<{ agentId: string }> }> }
          const s = sessions.find((x) => x.identity === identity)
          return s?.leases.filter((l) => l.agentId === a.agentId).length ?? 0
        },
        (n) => n === 2,
        (n) => `${n} lease(s) for ${a.agentId}, expected 2`,
      )
      await step('page.close() closes it', () => newPage.close())
    }

    // 11. ACL through Playwright's own view. The mux already denies a cross-agent Target.attachToTarget; the
    //     point here is that a peer's tab must not even APPEAR as a Page, since a framework client acts on
    //     what its registry lists.
    await expect(
      'a peer agent’s tab is invisible to this browser',
      async () => contextA.pages().map((p) => p.url()),
      (urls) => !urls.some((u) => u.includes('__b_')),
      (urls) => `sees ${urls.length}: ${urls.join(', ')}`,
    )

    // 12. Two Playwright connections, same identity, concurrently - no interleaving of their sessions.
    const browserB = await step('a second agent connects concurrently', () => chromium.connectOverCDP(b.cdpUrl))
    if (browserB) {
      open.push(browserB)
      const ctxB = browserB.contexts()[0]
      const pageB = ctxB?.pages()[0]
      const markerB = 'pw__b_leased'
      if (pageB) {
        await step('agent B drives its own tab', () => pageB.goto(page.pageUrl(markerB), { waitUntil: 'domcontentloaded', timeout: STEP_MS }))
        await expect('agent B reads back its OWN marker', () => pageB.textContent('#marker', { timeout: STEP_MS }), (t) => t === markerB, (t) => `"${t}"`)
        if (pageA) {
          await expect('agent A still reads back ITS marker (no cross-talk)', () => pageA!.textContent('#marker', { timeout: STEP_MS }), (t) => t === markerA, (t) => `"${t}"`)
        }
      } else {
        check('agent B drives its own tab', false, 'agent B saw no page')
      }
    }

    // 13-14. gtm attaches and detaches per operation, so reconnect has to work, and a detach must never take
    //        the tab (or a peer) down with it - browser.close() on a connectOverCDP browser is a DISCONNECT.
    await step('browser.close() detaches without killing the tab', async () => {
      await browserA.close()
      open.splice(open.indexOf(browserA), 1)
    })
    await delay(250)
    const reconnected = await step('reconnect after detach', () => chromium.connectOverCDP(a.cdpUrl))
    if (reconnected) {
      open.push(reconnected)
      const p = reconnected.contexts()[0]?.pages()[0]
      if (p) {
        await expect('the tab survived the detach with its state', () => p.textContent('#marker', { timeout: STEP_MS }), (t) => t === markerA, (t) => `"${t}"`)
      } else {
        check('the tab survived the detach with its state', false, 'no page after reconnect')
      }
    }
  } finally {
    for (const br of open) await br.close().catch(() => {})
    for (const r of relays) r.close()
    page.close()
    await handle.close().catch(() => {})
    rmSync(profiles, { recursive: true, force: true })
  }
  finish()
}

function finish(): void {
  const passed = results.every((r) => r.ok)
  console.log(`\n${passed ? 'PASS' : 'FAIL'} - ${results.filter((r) => r.ok).length}/${results.length} checks\n`)
  process.exitCode = passed ? 0 : 1
}

main().catch((e) => {
  console.error('\nplaywright harness errored:', e)
  process.exitCode = 1
})
