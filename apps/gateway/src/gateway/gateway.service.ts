// CdpGatewayService - the gateway's control plane. Wraps @chromatrix/core's Orchestrator (identities +
// Chrome supervisors + tab leasing) and adds the two things the domain layer deliberately doesn't know
// about: (1) a per-identity CdpMux (upstream-only, embedded - fed already-upgraded sockets by the raw
// `upgrade` handler, never a self-hosted server) carrying the Runtime.enable-suppression interceptor, and
// (2) the derived per-agent token that turns an `allocateTab` into a scoped `…/cdp/<id>/<agentId>?token=…` URL.
//
// NOTHING about authorization is stored. The token is `HMAC(accessToken, identity ‖ agentId)`, recomputed on
// each upgrade rather than looked up; the per-tab ACL is derived live from the TabPool on every attach, so
// lease/release takes effect immediately: a client's scope `allows(t)` iff its agent currently leases target
// `t`.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Injectable, Logger } from '@nestjs/common'
import { CdpClient, CdpMux, type ClientScope } from '@chromatrix/cdp'
import { deriveAgentToken, tokensMatch } from '@chromatrix/shared'
import { runtimeEnableSuppressInterceptor } from '@chromatrix/fidelity'
import { getAccessToken } from '../auth/auth.ts'
import {
  IdentityRegistry,
  Orchestrator,
  assertValidIdentityId,
  type Lease,
  type SessionInfo,
} from '@chromatrix/core'

/** A capture must not outlive the dashboard's poll interval - CdpClient.send has no timeout of its own. */
const CAPTURE_TIMEOUT_MS = 4_000

/** Commit, not load - but still bounded, since CdpClient.send has no timeout of its own. */
const NAVIGATE_TIMEOUT_MS = 15_000

/**
 * Chrome refuses to make a window smaller than this, so these are the smallest *content* sizes reachable with
 * real windows (measured: an outer 200×200 request lands at 500×375 outer). Requests below the floor are
 * clamped rather than silently misreported - `setTabViewport` always answers with what was actually achieved.
 *
 * The practical consequence: phone-width viewports (375 CSS px) are NOT reachable this way. Getting one would
 * mean `Emulation.setDeviceMetricsOverride`, which trades away the fidelity this design is built on.
 */
export const MIN_VIEWPORT_WIDTH = 500
export const MIN_VIEWPORT_HEIGHT = 288

export interface Viewport {
  width: number
  height: number
}

export interface GatewaySettings {
  /** Applied to every new tab that doesn't specify its own size. Unset = leave Chrome's default alone. */
  defaultViewport?: Viewport
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export interface AllocatedTab {
  identity: string
  agentId: string
  targetId: string
  createdAt: string
  /** Scoped, agent-bound raw-CDP endpoint. The agent connects a raw CdpClient here and drives its tab(s). */
  cdpUrl: string
  /** Live page URL, read per-call from CDP (the TabPool doesn't track it). Absent if the target is gone. */
  url?: string
  /** Live page title, same caveat as `url`. Empty string for a page that hasn't set one. */
  title?: string
}

/** A running identity plus every tab in it - what the dashboard renders per card. */
export interface SessionView extends SessionInfo {
  leases: AllocatedTab[]
  /**
   * Live pages that no agent leases. A human opening a link in takeover, or a popup whose opener was itself
   * unowned, produces a real tab that the lease table never sees. Reported alongside the leases because the
   * alternative is what it replaced: a card claiming the session has no tabs while Chrome has windows open.
   */
  unowned: TargetView[]
}

/** A live page target in an identity's Chrome, annotated with the agent leasing it (if any). */
export interface TargetView {
  targetId: string
  url: string
  title: string
  agentId?: string
}

@Injectable()
export class CdpGatewayService {
  private readonly log = new Logger('CdpGateway')
  private readonly orchestrator: Orchestrator
  /** One upstream mux per running identity (created on start, closed on stop). */
  private readonly muxes = new Map<string, CdpMux>()
  /** In-flight screenshot per `identity targetId`, so a slow page can't stack up attaches under polling. */
  private readonly captures = new Map<string, Promise<Buffer>>()
  /** Gateway-wide settings, persisted beside the profiles so they survive a restart. */
  private readonly settingsPath: string
  private settingsCache: GatewaySettings | undefined

  /** Public WS origin the scoped cdpUrl is built from (e.g. `ws://127.0.0.1:8830`). Set in main.ts after listen. */
  publicWsOrigin = ''

  /** The same origin as HTTP (for the takeover viewer URL): `ws://` → `http://`, `wss://` → `https://`. */
  publicHttpOrigin(): string {
    return this.publicWsOrigin.replace(/^ws/, 'http')
  }

  constructor(profilesRoot: string) {
    this.orchestrator = new Orchestrator(new IdentityRegistry(profilesRoot))
    this.settingsPath = join(profilesRoot, 'settings.json')
  }

  // ── Provisioning (the MCP/management surface calls these) ───────────────────────────────────────────────

  /**
   * Create the identity's profile dir. Does NOT launch Chrome - creating and starting are separate verbs so a
   * session can rest stopped between runs (see `startIdentity`).
   *
   * Rejects an id that already exists rather than quietly succeeding: `mkdir -p` semantics would silently
   * adopt another identity's logged-in profile, which looks like "created" and behaves like "took over".
   */
  createIdentity(id: string): { id: string; profileDir: string } {
    assertValidIdentityId(id)
    if (this.orchestrator.registry.exists(id)) {
      throw new Error(`identity "${id}" already exists`)
    }
    const identity = this.orchestrator.createIdentity(id)
    this.log.log(`created identity "${id}" → ${identity.profileDir}`)
    return { id: identity.id, profileDir: identity.profileDir }
  }

  /**
   * Stop the identity and delete its profile dir. Irreversible - this is the one call that destroys the
   * signed-in session, so the dashboard gates it behind a type-the-id confirmation.
   */
  async deleteIdentity(id: string): Promise<void> {
    assertValidIdentityId(id)
    await this.stopIdentity(id) // releases the mux + tokens, SIGTERMs Chrome, frees the profile lock
    await this.orchestrator.deleteIdentity(id) // stop is idempotent; this one also removes the dir
    this.log.log(`deleted identity "${id}"`)
  }

  async startIdentity(id: string, opts: { headless?: boolean } = {}): Promise<SessionInfo> {
    assertValidIdentityId(id)
    const session = await this.orchestrator.startIdentity(id, { headless: opts.headless })
    if (!this.muxes.has(id)) {
      const mux = await CdpMux.connect({
        browserWsUrl: session.supervisor.browserWsUrl,
        interceptor: runtimeEnableSuppressInterceptor,
      })
      this.muxes.set(id, mux)
    }
    this.log.log(`started identity "${id}"${opts.headless ? ' (headless)' : ''}`)
    return this.sessionInfo(id)
  }

  /**
   * Every session - running *and* stopped - each with the tabs it currently leases. The leases live in the
   * TabPool (the gateway is the source of truth), so a dashboard reload re-renders the real tab list instead
   * of an empty one.
   *
   * A stopped session short-circuits: it has no Chrome to ask, so it costs no CDP round trip and reports no
   * tabs. It still appears in the list, because its profile dir is exactly what makes it resumable.
   *
   * Each lease is enriched with the target's live `url`/`title` - the TabPool deliberately doesn't track those
   * (a tab's URL is the agent's business, and it changes without telling us), so they're read per call. That
   * costs one `Target.getTargets` per identity per poll, which is what lets the dashboard label a tab by its
   * page rather than by a truncated targetId. A failed read degrades to bare leases rather than failing the
   * whole list - an identity being torn down mid-poll shouldn't blank the other cards.
   */
  async listSessions(): Promise<SessionView[]> {
    return Promise.all(
      this.orchestrator.listSessions().map(async (s) => {
        if (s.state !== 'running') return { ...s, leases: [], unowned: [] }
        const targets = await this.listTargets(s.identity).catch(() => [] as TargetView[])
        const byTarget = new Map(targets.map((t) => [t.targetId, t]))
        const leases = this.listTabs(s.identity).map((tab) => ({
          ...tab,
          url: byTarget.get(tab.targetId)?.url,
          title: byTarget.get(tab.targetId)?.title,
        }))
        // Free: listTargets was already fetched above for the url/title enrichment, and it annotates every
        // page with its leasing agent. The unowned ones are simply the rest.
        const unowned = targets.filter((t) => !t.agentId)
        return { ...s, leases, unowned }
      }),
    )
  }

  /** The tabs currently leased under `identity`, each with the scoped URL its agent connects on. */
  listTabs(identity: string): AllocatedTab[] {
    if (!this.orchestrator.isRunning(identity)) return []
    return this.orchestrator
      .session(identity)
      .tabs.list()
      .map((lease) => this.describeTab(lease, this.tokenFor(lease.identity, lease.agentId)))
  }

  /**
   * Live page targets in an identity's Chrome, annotated with the leasing agent. This is what the takeover
   * viewer picks from: it lists what a human can actually look at, which is broader than the lease table
   * (a tab the agent navigated to a popup, say, is still a real page).
   */
  async listTargets(identity: string): Promise<TargetView[]> {
    if (!this.orchestrator.isRunning(identity)) return []
    const tabs = this.orchestrator.session(identity).tabs
    const { targetInfos } = await this.controlClient(identity).send<{
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>
    }>('Target.getTargets')
    return targetInfos
      .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, agentId: tabs.get(t.targetId)?.agentId }))
  }

  /**
   * A one-off JPEG of a live target - what the dashboard's tab cards poll for passive monitoring.
   *
   * Deliberately *not* a screencast: `Page.startScreencast` is repaint-driven (a static page emits one frame
   * and then nothing), which is why the takeover hub has to cache frames. `Page.captureScreenshot` asks for a
   * fresh raster instead, so it works on an idle page. It also does NOT call `Target.activateTarget` - the
   * takeover path does that because a screencast needs the page composited, but stealing window focus once
   * per tab per poll would make the identity's Chrome unusable. If a backgrounded tab turns out not to raster,
   * that surfaces as a timeout below rather than a hang.
   *
   * Concurrent requests for the same target share one capture: the poll interval is fixed but a slow page can
   * exceed it, and stacking attaches per tab is how you get a Chrome full of orphaned sessions.
   */
  captureTab(identity: string, targetId: string): Promise<Buffer> {
    const key = `${identity}\u0000${targetId}`
    const inFlight = this.captures.get(key)
    if (inFlight) return inFlight
    const capture = this.doCaptureTab(identity, targetId).finally(() => this.captures.delete(key))
    this.captures.set(key, capture)
    return capture
  }

  private async doCaptureTab(identity: string, targetId: string): Promise<Buffer> {
    assertValidIdentityId(identity)
    if (!this.orchestrator.isRunning(identity)) throw new Error(`identity "${identity}" is not running`)
    const client = this.controlClient(identity)
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    try {
      const { data } = await withTimeout(
        client.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 55 }, sessionId),
        CAPTURE_TIMEOUT_MS,
        `screenshot of ${targetId} timed out`,
      )
      return Buffer.from(data, 'base64')
    } finally {
      // Detach even on failure: the control client is shared (takeover uses it too), so a leaked session per
      // failed capture would accumulate for the lifetime of the identity.
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }

  /**
   * Lease a fresh tab for `agentId` under `identity` and hand back the scoped URL the agent connects with.
   *
   * Viewport precedence: explicit `width`/`height` → the global default from settings → whatever size Chrome
   * opened the window at. An agent allocating over MCP has no screen to measure, so "fit the takeover pane"
   * is deliberately a *dashboard* behaviour (it measures and passes explicit dimensions), not a server one.
   */
  async allocateTab(
    identity: string,
    agentId: string,
    opts: { url?: string; width?: number; height?: number; compat?: boolean } = {},
  ): Promise<AllocatedTab> {
    assertValidIdentityId(identity)
    if (!this.muxes.has(identity)) {
      throw new Error(`identity "${identity}" is not running - startIdentity first`)
    }
    const lease = await this.orchestrator.allocateTab(identity, agentId, { url: opts.url, compat: opts.compat })
    const wanted =
      opts.width && opts.height ? { width: opts.width, height: opts.height } : this.settings().defaultViewport
    if (wanted) {
      // A viewport failure must not lose the tab - the lease is already real and the agent can still drive it.
      await this.setTabViewport(identity, lease.targetId, wanted.width, wanted.height).catch((err) =>
        this.log.warn(`could not size tab ${lease.targetId}: ${err instanceof Error ? err.message : err}`),
      )
    }
    return this.describeTab(lease, this.tokenFor(identity, agentId))
  }

  // ── Per-tab viewport ────────────────────────────────────────────────────────────────────────────────────

  /** The tab's current *content* size, measured without executing anything inside the page. */
  async getTabViewport(identity: string, targetId: string): Promise<Viewport> {
    const client = this.controlClient(identity)
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    try {
      return await this.measure(client, sessionId)
    } finally {
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }

  /**
   * Resize a tab's window so its *content area* is exactly `width`×`height`, and answer with what was actually
   * achieved (clamped at the floor above).
   *
   * Window bounds are outer dimensions, so we measure the browser-chrome delta for this specific window rather
   * than assuming one - it varies with the bookmarks bar, platform, and Chrome version. Measured via
   * `Page.getLayoutMetrics` instead of `Runtime.evaluate` so nothing observable runs inside the agent's page.
   * One correction step lands it exactly (verified across headed and headless).
   */
  async setTabViewport(identity: string, targetId: string, width: number, height: number): Promise<Viewport> {
    assertValidIdentityId(identity)
    const want = {
      width: Math.max(MIN_VIEWPORT_WIDTH, Math.round(width)),
      height: Math.max(MIN_VIEWPORT_HEIGHT, Math.round(height)),
    }
    const client = this.controlClient(identity)
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    try {
      const { windowId } = await client.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      const { bounds } = await client.send<{ bounds: { width: number; height: number } }>(
        'Browser.getWindowBounds',
        { windowId },
      )
      const content = await this.measure(client, sessionId)
      const dw = bounds.width - content.width
      const dh = bounds.height - content.height
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: want.width + dw, height: want.height + dh, windowState: 'normal' },
      })
      return await this.measure(client, sessionId)
    } finally {
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }

  private async measure(client: CdpClient, sessionId: string): Promise<Viewport> {
    const m = await client.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
      'Page.getLayoutMetrics',
      {},
      sessionId,
    )
    return { width: m.cssLayoutViewport.clientWidth, height: m.cssLayoutViewport.clientHeight }
  }

  /**
   * Point a tab at a URL. Used by the takeover view's address field, so a human can steer a tab without
   * having to drive the page's own chrome (which the screencast doesn't include).
   *
   * Resolves when the navigation is *committed*, not when the page finishes loading - waiting for load would
   * hang the request on a slow or never-idle page.
   */
  async navigateTab(identity: string, targetId: string, url: string): Promise<{ url: string }> {
    assertValidIdentityId(identity)
    const client = this.controlClient(identity)
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    try {
      const result = await withTimeout(
        client.send<{ errorText?: string }>('Page.navigate', { url }, sessionId),
        NAVIGATE_TIMEOUT_MS,
        `navigation to ${url} timed out`,
      )
      if (result.errorText) throw new Error(result.errorText)
      return { url }
    } finally {
      await client.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }

  // ── Global settings ─────────────────────────────────────────────────────────────────────────────────────

  /** Gateway-wide settings, read through a memo so the common path doesn't hit the disk. */
  settings(): GatewaySettings {
    if (!this.settingsCache) {
      try {
        this.settingsCache = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as GatewaySettings
      } catch {
        this.settingsCache = {} // absent or corrupt → defaults; this file is a convenience, not a source of truth
      }
    }
    return this.settingsCache
  }

  saveSettings(next: GatewaySettings): GatewaySettings {
    this.settingsCache = next
    writeFileSync(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  async releaseTab(identity: string, targetId: string): Promise<void> {
    assertValidIdentityId(identity)
    await this.orchestrator.releaseTab(identity, targetId)
  }

  /**
   * Close a tab whether or not anything leases it - the dashboard's close button.
   *
   * `releaseTab` is the agent-facing lease verb and deliberately no-ops on a target it doesn't lease, which
   * leaves no way to shut an unowned tab (one a human opened in takeover) except stopping the whole identity.
   * A leased target still goes through release, so the pool's bookkeeping stays authoritative; only the
   * unowned case reaches for the control client.
   */
  async closeTab(identity: string, targetId: string): Promise<void> {
    assertValidIdentityId(identity)
    if (!this.orchestrator.isRunning(identity)) return
    if (this.orchestrator.session(identity).tabs.get(targetId)) {
      await this.orchestrator.releaseTab(identity, targetId)
      return
    }
    await this.controlClient(identity)
      .send('Target.closeTarget', { targetId })
      .catch(() => {
        /* already gone (the human closed it first) - closing a closed tab is the desired end state */
      })
  }

  async health(identity: string): Promise<{ identity: string; product: string }> {
    assertValidIdentityId(identity)
    return { identity, product: await this.orchestrator.health(identity) }
  }

  async stopIdentity(id: string): Promise<void> {
    assertValidIdentityId(id)
    this.muxes.get(id)?.close()
    this.muxes.delete(id)
    // Agent tokens are NOT revoked here: they are derived rather than stored, so there is nothing to
    // delete. A token outliving its identity grants nothing on its own - the ACL is computed from live
    // TabPool leases, and stopping has just destroyed them. See @chromatrix/shared/token.
    await this.orchestrator.stopIdentity(id)
  }

  async shutdown(): Promise<void> {
    for (const mux of this.muxes.values()) mux.close()
    this.muxes.clear()
    await this.orchestrator.shutdown()
  }

  // ── Raw-CDP upgrade path (the http `upgrade` handler calls this) ─────────────────────────────────────────

  /**
   * Resolve a `/cdp/<identity>/<agentId>?token=…` upgrade to the mux + the live per-tab ACL scope, or throw.
   *
   * With derived tokens there is no table to look the caller up in, so the flow inverts: the client *claims*
   * an agentId and the token proves the claim. Recomputing the HMAC for (identity, claimedAgent) and comparing
   * in constant time is equivalent to the old lookup - a caller who cannot forge the HMAC cannot assert an
   * agentId that isn't theirs, and the identity is bound in because it is an HMAC input.
   */
  resolveCdpUpgrade(
    identity: string,
    agentId: string | undefined,
    token: string | undefined,
    compat = false,
  ): { mux: CdpMux; scope: ClientScope; compat: boolean } {
    if (!agentId) throw new Error('missing agent')
    if (!token) throw new Error('missing token')
    if (!tokensMatch(token, this.tokenFor(identity, agentId))) {
      throw new Error(`token is not valid for agent "${agentId}" on identity "${identity}"`)
    }
    const mux = this.muxes.get(identity)
    if (!mux) throw new Error(`identity "${identity}" is not running`)
    return { mux, scope: this.scopeFor(identity, agentId, compat), compat }
  }

  /** Control CDP client for a running identity - used by the takeover route. */
  controlClient(identity: string) {
    return this.orchestrator.client(identity)
  }

  isRunning(id: string): boolean {
    return this.orchestrator.isRunning(id)
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────

  /** The live ACL: an agent's client may see/attach exactly the targets its TabPool leases grant, right now. */
  private scopeFor(identity: string, agentId: string, compat: boolean): ClientScope {
    const tabs = this.orchestrator.session(identity).tabs
    return {
      identity,
      allows: (targetId) => tabs.isLeasedBy(agentId, targetId),
      allowedTargets: () => tabs.targetsFor(agentId),
      // A tab the agent opened over its own CDP connection, or a popup opened BY one of its tabs, is leased
      // to it exactly as if it had called `allocateTab` - so it shows up in the dashboard, counts against the
      // cap, and gets reaped on release.
      adopt: (targetId) => {
        tabs.adopt(agentId, targetId, { compat })
        this.log.log(`agent "${agentId}" adopted tab ${targetId} on "${identity}"`)
      },
      release: (targetId) => tabs.drop(targetId),
    }
  }

  /**
   * The agent's CDP credential - `HMAC(accessToken, identity ‖ agentId)`, derived rather than stored.
   *
   * One credential per (identity, agent), not per tab: an agent holds one connection for all its tabs and the
   * scope is derived live from its leases. Deriving instead of minting means the token table is gone and the
   * value survives a gateway restart, so an agent reconnecting with a URL it was handed an hour ago still
   * works. See @chromatrix/shared/token for what that trades away (per-agent revocation).
   */
  private tokenFor(identity: string, agentId: string): string {
    return deriveAgentToken(getAccessToken(), identity, agentId)
  }

  private describeTab(lease: Lease, token: string): AllocatedTab {
    // The agent is named in the PATH, not the query: it is part of what is being addressed (whose scope this
    // connection attaches under), not a credential. It also has to be stated explicitly at all, because the
    // agentId cannot be recovered from the HMAC - the client names itself and the token proves the claim.
    // Percent-encoded since agentId is an opaque caller-chosen string.
    const agent = encodeURIComponent(lease.agentId)
    // `compat` rides in the query beside the token because, like the token, it qualifies the CONNECTION rather
    // than naming a resource - and unlike the token it is not a credential, so a caller may equally well add
    // it by hand. Embedding it here is what lets an agent keep following the "drive the URL you were handed"
    // rule instead of having to rebuild it.
    const query = `token=${token}${lease.compat ? '&compat=1' : ''}`
    return {
      identity: lease.identity,
      agentId: lease.agentId,
      targetId: lease.targetId,
      createdAt: lease.createdAt,
      cdpUrl: `${this.publicWsOrigin}/cdp/${lease.identity}/${agent}?${query}`,
    }
  }

  private sessionInfo(id: string): SessionInfo {
    const info = this.orchestrator.listSessions().find((s) => s.identity === id)
    if (!info) throw new Error(`identity "${id}" is not running`)
    return info
  }
}
