// Single-writer profile lock. Nobody in the CDP-orchestration space documents one, so we build it (PRD §6/§7
// S3): exactly one chromatrix process may own an identity's `--user-data-dir` at a time, or two Chromes race
// on the same cookie store and corrupt it. This is an ORCHESTRATOR-level lock, distinct from Chrome's own
// SingletonLock (which @chromatrix/fidelity cleans on relaunch) - it guards against a second *supervisor*.
//
// Mechanism: an atomic O_EXCL lockfile in the profile dir holding {pid, host, acquiredAt}. If it already
// exists we check whether the recorded pid is still alive on this host; a dead owner's lock is stale and gets
// reclaimed (covers a hard-killed prior run). Released on stop and best-effort on process exit.

import { openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

const LOCKFILE = '.chromatrix.lock'

interface LockRecord {
  pid: number
  host: string
  acquiredAt: string
}

export class ProfileLockError extends Error {
  constructor(
    readonly profileDir: string,
    readonly heldBy: LockRecord,
  ) {
    super(`profile ${profileDir} is locked by pid ${heldBy.pid} on ${heldBy.host} (since ${heldBy.acquiredAt})`)
    this.name = 'ProfileLockError'
  }
}

/** True if `pid` is a live process on THIS host (a lock from another host is always treated as held). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // ESRCH → no such process (stale). EPERM → alive but not ours to signal (still held).
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class ProfileLock {
  private held = false
  private readonly path: string
  private readonly onExit = () => this.release()

  constructor(readonly profileDir: string) {
    this.path = join(profileDir, LOCKFILE)
  }

  /** Acquire the lock, reclaiming a stale one. Throws ProfileLockError if a live owner holds it. */
  acquire(): void {
    if (this.held) return
    this.tryCreate()
    this.held = true
    process.once('exit', this.onExit)
  }

  private tryCreate(): void {
    const record: LockRecord = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }
    try {
      const fd = openSync(this.path, 'wx') // O_CREAT|O_EXCL - atomic "create if absent"
      writeFileSync(fd, JSON.stringify(record))
      closeSync(fd)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const existing = this.readRecord()
      if (existing && existing.host === hostname() && !pidAlive(existing.pid)) {
        rmSync(this.path, { force: true }) // reclaim stale lock, then retry once
        this.tryCreate()
        return
      }
      throw new ProfileLockError(this.profileDir, existing ?? record)
    }
  }

  private readRecord(): LockRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as LockRecord
    } catch {
      return undefined
    }
  }

  release(): void {
    if (!this.held) return
    this.held = false
    process.removeListener('exit', this.onExit)
    try {
      // Only remove the file if it is still ours (avoid deleting a lock a reclaimer took over).
      const rec = this.readRecord()
      if (!rec || rec.pid === process.pid) rmSync(this.path, { force: true })
    } catch {
      /* best effort */
    }
  }

  get isHeld(): boolean {
    return this.held
  }
}
