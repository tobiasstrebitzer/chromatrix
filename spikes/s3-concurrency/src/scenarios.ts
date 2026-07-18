// S3 scenarios — the shared-tab-vs-isolated-context question from docs/PRD.md §7.
// All operate on one Chrome ("one identity"). ORIGIN is a real https origin so cookies/localStorage work.

import { CdpClient } from './cdp-client.ts'

const ORIGIN = 'https://example.com'

interface Tab {
  targetId: string
  sessionId: string
}

async function openTab(client: CdpClient, url: string, browserContextId?: string): Promise<Tab> {
  const params: Record<string, unknown> = { url }
  if (browserContextId) params.browserContextId = browserContextId
  const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', params)
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Page.enable', {}, sessionId)
  await client.send('Network.enable', {}, sessionId)
  await Promise.race([
    new Promise<void>((res) => client.on('Page.loadEventFired', (_p, sid) => sid === sessionId && res())),
    new Promise<void>((res) => setTimeout(res, 8000)),
  ])
  return { targetId, sessionId }
}

async function evalTab<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<{ result?: { value?: T } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  return r.result?.value as T
}

async function cookieValue(client: CdpClient, sessionId: string, name: string): Promise<string | undefined> {
  const { cookies } = await client.send<{ cookies: Array<{ name: string; value: string }> }>(
    'Network.getCookies',
    { urls: [ORIGIN + '/'] },
    sessionId,
  )
  return cookies.find((c) => c.name === name)?.value
}

async function closeTab(client: CdpClient, targetId: string): Promise<void> {
  await client.send('Target.closeTarget', { targetId }).catch(() => {})
}

// ── A) Shared context, one tab per agent (the chosen v1 model) ─────────────────────────────────────────
export interface SharedResult {
  agents: number
  allCompleted: boolean
  allSeeSharedCookie: boolean
  allPerAgentKeysPresent: boolean
  sharedKeyFinalValue: string
}

export async function sharedContextConcurrency(client: CdpClient, n: number): Promise<SharedResult> {
  const agents = await Promise.all(
    Array.from({ length: n }, async (_v, i) => {
      try {
        const tab = await openTab(client, ORIGIN + '/')
        const own = await evalTab<string>(
          client,
          tab.sessionId,
          `localStorage.setItem('shared','agent${i}'); localStorage.setItem('k${i}','v${i}'); localStorage.getItem('k${i}')`,
        )
        return { i, tab, ok: own === `v${i}` }
      } catch {
        return { i, tab: null as Tab | null, ok: false }
      }
    }),
  )
  const allCompleted = agents.every((a) => a.ok)

  // Agent 0 sets a session cookie; do all agents' sessions see it (shared context ⇒ yes)?
  const a0 = agents.find((a) => a.tab)
  let allSeeSharedCookie = false
  if (a0?.tab) {
    await client.send('Network.setCookie', { url: ORIGIN + '/', name: 'sess', value: 'shared123' }, a0.tab.sessionId)
    const seen = await Promise.all(
      agents.filter((a) => a.tab).map((a) => cookieValue(client, a.tab!.sessionId, 'sess')),
    )
    allSeeSharedCookie = seen.every((v) => v === 'shared123')
  }

  // Fresh tab in the same context sees every agent's localStorage write (shared origin storage).
  const fresh = await openTab(client, ORIGIN + '/')
  const allPerAgentKeysPresent = await evalTab<boolean>(
    client,
    fresh.sessionId,
    `Array.from({length:${n}},(_,i)=>localStorage.getItem('k'+i)==='v'+i).every(Boolean)`,
  )
  const sharedKeyFinalValue = await evalTab<string>(client, fresh.sessionId, `localStorage.getItem('shared')`)

  for (const a of agents) if (a.tab) await closeTab(client, a.tab.targetId)
  await closeTab(client, fresh.targetId)

  return { agents: n, allCompleted, allSeeSharedCookie, allPerAgentKeysPresent, sharedKeyFinalValue }
}

// ── B) Navigation stomping: two agents share ONE tab ───────────────────────────────────────────────────
export interface StompResult {
  inFlightBroke: boolean
  detail: string
}

export async function navigationStomp(client: CdpClient): Promise<StompResult> {
  const tab = await openTab(client, ORIGIN + '/')
  // Agent B: an in-flight evaluation that resolves after 1.5s.
  const bPromise = client
    .send<{ result?: { value?: string } }>(
      'Runtime.evaluate',
      { expression: `new Promise(r=>setTimeout(()=>r('B-ok:'+location.host),1500))`, awaitPromise: true, returnByValue: true },
      tab.sessionId,
    )
    .then((r) => ({ ok: true, val: r.result?.value ?? '' }))
    .catch((e: Error) => ({ ok: false, val: e.message }))

  // Agent A: navigates the SAME tab mid-flight.
  await new Promise((r) => setTimeout(r, 300))
  await client.send('Page.navigate', { url: 'https://example.org/' }, tab.sessionId).catch(() => {})

  const b = await bPromise
  await closeTab(client, tab.targetId)
  return { inFlightBroke: !b.ok, detail: b.ok ? `agent B returned "${b.val}" (survived)` : `agent B failed: ${b.val}` }
}

// ── C) Per-job isolated contexts + persistent-login breakage ────────────────────────────────────────────
export interface IsolationResult {
  contexts: number
  storageIsolated: boolean
  cookiesIsolated: boolean
  persistentLoginVisibleInEphemeral: boolean
}

export async function isolatedContexts(client: CdpClient, n: number): Promise<IsolationResult> {
  const ctxs = await Promise.all(
    Array.from({ length: n }, async (_v, i) => {
      const { browserContextId } = await client.send<{ browserContextId: string }>('Target.createBrowserContext', {
        disposeOnDetach: false,
      })
      const tab = await openTab(client, ORIGIN + '/', browserContextId)
      await evalTab(client, tab.sessionId, `localStorage.setItem('secret','ctx${i}')`)
      await client.send('Network.setCookie', { url: ORIGIN + '/', name: 'c', value: `ctx${i}` }, tab.sessionId)
      return { i, browserContextId, tab }
    }),
  )
  // Each context should read back ONLY its own value.
  const reads = await Promise.all(
    ctxs.map(async (c) => ({
      i: c.i,
      ls: await evalTab<string>(client, c.tab.sessionId, `localStorage.getItem('secret')`),
      cookie: await cookieValue(client, c.tab.sessionId, 'c'),
    })),
  )
  const storageIsolated = reads.every((r) => r.ls === `ctx${r.i}`)
  const cookiesIsolated = reads.every((r) => r.cookie === `ctx${r.i}`)

  // Persistent-login breakage: set a "login" cookie in the DEFAULT context, check an EPHEMERAL context.
  const defTab = await openTab(client, ORIGIN + '/') // default context
  await client.send('Network.setCookie', { url: ORIGIN + '/', name: 'login', value: 'DEFAULT-USER' }, defTab.sessionId)
  const { browserContextId: ephId } = await client.send<{ browserContextId: string }>('Target.createBrowserContext', {})
  const ephTab = await openTab(client, ORIGIN + '/', ephId)
  const loginInEph = await cookieValue(client, ephTab.sessionId, 'login')

  // Cleanup.
  for (const c of ctxs) {
    await closeTab(client, c.tab.targetId)
    await client.send('Target.disposeBrowserContext', { browserContextId: c.browserContextId }).catch(() => {})
  }
  await closeTab(client, defTab.targetId)
  await closeTab(client, ephTab.targetId)
  await client.send('Target.disposeBrowserContext', { browserContextId: ephId }).catch(() => {})

  return {
    contexts: n,
    storageIsolated,
    cookiesIsolated,
    persistentLoginVisibleInEphemeral: loginInEph !== undefined,
  }
}
