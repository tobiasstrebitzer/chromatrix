// Orphaned-Chrome-tree reaper. A supervisor crash or hard-kill can leave a Chrome
// (plus its renderer/GPU/utility children) still bound to an identity's --user-data-dir. On relaunch we must
// clear those before a fresh Chrome can take the profile, or the ProfileLock is free but the OS still has a
// zombie holding the dir. We find them by the one thing that is unique per identity: the --user-data-dir flag.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/** PIDs of live processes whose command line contains `--user-data-dir=<profileDir>` (excluding ourselves). */
export async function findChromePidsForProfile(profileDir: string): Promise<number[]> {
  try {
    // pgrep -f matches the full argv. The needle is the exact flag so we never match an unrelated Chrome.
    // `--` terminates option parsing so the pattern's own leading `--` isn't read as pgrep flags (BSD/macOS).
    const { stdout } = await pexec('pgrep', ['-f', '--', `--user-data-dir=${profileDir}`])
    return stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch (e) {
    // pgrep exits 1 with no matches - that's "none", not an error.
    if ((e as { code?: number }).code === 1) return []
    throw e
  }
}

/** Kill any orphaned Chrome tree bound to this profile. SIGTERM first (lets Chrome flush), then SIGKILL. */
export async function reapProfile(profileDir: string, opts: { graceMs?: number } = {}): Promise<number> {
  const pids = await findChromePidsForProfile(profileDir)
  if (pids.length === 0) return 0
  for (const pid of pids) trySignal(pid, 'SIGTERM')
  await delay(opts.graceMs ?? 2000)
  for (const pid of await findChromePidsForProfile(profileDir)) trySignal(pid, 'SIGKILL')
  return pids.length
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
