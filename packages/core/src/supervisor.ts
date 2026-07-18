// ChromeSupervisor — owns the lifecycle of ONE identity's Chrome (PRD §4, NEXT-SESSION §2). On start it takes
// the single-writer profile lock, reaps any orphaned Chrome tree still bound to the profile dir, launches the
// real headed Chrome via @chromatrix/fidelity, and opens a control CdpClient (used by the TabPool to create/
// close targets and to health-check). On stop it SIGTERMs Chrome so cookies flush and releases the lock.

import { launchChrome, type ChromeHandle } from '@chromatrix/fidelity'
import { CdpClient } from '@chromatrix/cdp'
import type { Identity } from './identity.ts'
import { ProfileLock } from './profile-lock.ts'
import { reapProfile } from './reaper.ts'

export type SupervisorState = 'stopped' | 'starting' | 'running'

export interface SupervisorOptions {
  headless?: boolean
  /** Page the identity's window opens on (about:blank by default; tabs are created per-lease). */
  startUrl?: string
}

export class ChromeSupervisor {
  private state: SupervisorState = 'stopped'
  private chrome?: ChromeHandle
  private control?: CdpClient
  private readonly lock: ProfileLock

  constructor(
    readonly identity: Identity,
    private readonly options: SupervisorOptions = {},
  ) {
    this.lock = new ProfileLock(identity.profileDir)
  }

  get status(): SupervisorState {
    return this.state
  }

  /** The control CDP client (browser-level). Throws if not running. */
  get client(): CdpClient {
    if (!this.control) throw new Error(`supervisor for "${this.identity.id}" is not running`)
    return this.control
  }

  get browserWsUrl(): string {
    if (!this.chrome) throw new Error(`supervisor for "${this.identity.id}" is not running`)
    return this.chrome.browserWsUrl
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return
    this.state = 'starting'
    try {
      this.lock.acquire() // single-writer: fails fast if another supervisor owns this profile
      await reapProfile(this.identity.profileDir) // clear a crashed prior Chrome tree before relaunch
      this.chrome = await launchChrome({
        profileDir: this.identity.profileDir,
        headless: this.options.headless,
        startUrl: this.options.startUrl,
      })
      this.control = await CdpClient.connect(this.chrome.browserWsUrl)
      await this.health() // fail start if the control channel isn't actually usable
      this.state = 'running'
    } catch (e) {
      await this.stop() // roll back a partial start (unlock, kill) so the profile is reusable
      throw e
    }
  }

  /** Round-trip Browser.getVersion as a liveness probe. Returns the product string. */
  async health(timeoutMs = 5000): Promise<string> {
    const res = await withTimeout(
      this.client.send<{ product: string }>('Browser.getVersion'),
      timeoutMs,
      `health check for "${this.identity.id}"`,
    )
    return res.product
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    try {
      this.control?.close()
    } catch {
      /* already closed */
    }
    this.control = undefined
    this.chrome?.close() // SIGTERM for a persistent profile → Chrome flushes cookies to disk
    this.chrome = undefined
    this.lock.release()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
