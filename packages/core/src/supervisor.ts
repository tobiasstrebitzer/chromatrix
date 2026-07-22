// ChromeSupervisor - owns the lifecycle of ONE identity's Chrome. On start it takes
// the single-writer profile lock, reaps any orphaned Chrome tree still bound to the profile dir, launches the
// real headed Chrome via @chromatrix/fidelity, and opens a control CdpClient (used by the TabPool to create/
// close targets and to health-check). On stop it SIGTERMs Chrome so cookies flush and releases the lock.

import type { ChildProcess } from 'node:child_process'
import { launchChrome, type ChromeHandle } from '@chromatrix/fidelity'
import { CdpClient } from '@chromatrix/cdp'
import type { Identity } from './identity.ts'
import { ProfileLock } from './profile-lock.ts'
import { reapProfile } from './reaper.ts'

export type SupervisorState = 'stopped' | 'starting' | 'running'

/**
 * How long to wait for Chrome to exit after SIGTERM before escalating to SIGKILL. Flushing cookies takes
 * milliseconds; this is slack for a wedged renderer, not a normal-path delay.
 */
const STOP_GRACE_MS = 5_000

/** Time to wait for the process table to reflect a SIGKILL before giving up and returning anyway. */
const KILL_GRACE_MS = 1_000

export interface SupervisorOptions {
  headless?: boolean
  /**
   * Page the identity's window opens on. Omitted by default, which launches with NO startup window at all -
   * the only tabs that ever exist are the ones the gateway/agents lease. Set this only to force a landing page.
   */
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

  /**
   * Stop Chrome and release the profile.
   *
   * Waits for the process to actually exit rather than just signalling it. `close()` only sends SIGTERM, and
   * Chrome keeps writing to the profile dir while it flushes cookies - so a caller that treats `stop()` as
   * "the profile is now free" races that flush. Deleting an identity is exactly such a caller, and it failed
   * with ENOTEMPTY: `rm -rf` walked the tree while Chrome was still re-creating files in it.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopped'
    try {
      this.control?.close()
    } catch {
      /* already closed */
    }
    this.control = undefined
    const chrome = this.chrome
    this.chrome = undefined
    if (chrome) {
      chrome.close() // SIGTERM for a persistent profile → Chrome flushes cookies to disk
      await waitForExit(chrome.proc)
    }
    this.lock.release()
  }
}

/** Resolve once `proc` has exited, escalating SIGTERM → SIGKILL if it outstays the grace period. */
function waitForExit(proc: ChildProcess): Promise<void> {
  // Already reaped - `exit` will never fire again, so waiting on it would hang for the full grace period.
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      // Clear both, or a pending timer keeps the event loop alive after a clean exit.
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      resolve()
    }
    const termTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      // Don't hang forever if the pid is unreachable and `exit` never arrives.
      killTimer = setTimeout(resolve, KILL_GRACE_MS)
    }, STOP_GRACE_MS)
    proc.once('exit', finish)
  })
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
