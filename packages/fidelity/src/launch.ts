// Launch the real Google Chrome (channel=chrome) with chromatrix's fidelity flags. One Chrome per
// `--user-data-dir` = one identity. Persistent profiles get SIGTERM on close (Chrome flushes cookies/storage
// to disk) and a stale-singleton-lock cleanup on launch (so a hard-killed prior run can be reattached);
// ephemeral throwaways are hard-killed and their dir removed. Proven across spikes S2/S3/S4.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIDELITY_LAUNCH_FLAGS } from './flags.ts'

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface ChromeHandle {
  browserWsUrl: string
  userDataDir: string
  ephemeral: boolean
  proc: ChildProcess
  close: () => void
}

export interface LaunchOptions {
  headless?: boolean
  /** Persistent identity profile dir. Omit for an ephemeral throwaway (auto-removed on close). */
  profileDir?: string
  startUrl?: string
  /** Override the Chrome binary (defaults to macOS Google Chrome). */
  executablePath?: string
  /** Extra flags appended after the fidelity flag set. */
  extraArgs?: string[]
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<ChromeHandle> {
  const ephemeral = !opts.profileDir
  const userDataDir = opts.profileDir ?? mkdtempSync(join(tmpdir(), 'chromatrix-'))
  if (opts.profileDir) {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        rmSync(join(userDataDir, f), { force: true })
      } catch {
        /* best effort */
      }
    }
  }
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...FIDELITY_LAUNCH_FLAGS,
    ...(opts.headless ? ['--headless=new'] : []),
    ...(opts.extraArgs ?? []),
    // Only open a startup window when one was explicitly asked for. Passing a positional URL (or defaulting
    // it to about:blank) makes Chrome open a stray page target that nobody leased — it pollutes
    // Target.getTargets, is the tab a naive takeover attaches to, and confuses "how many tabs are open".
    // `--no-startup-window` keeps the browser process alive and still prints the DevTools endpoint, with
    // ZERO page targets; Target.createTarget then opens the first real window. Verified on Chrome 150.
    ...(opts.startUrl ? [opts.startUrl] : ['--no-startup-window']),
  ]
  const proc = spawn(opts.executablePath ?? DEFAULT_CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  const browserWsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not report a DevTools endpoint in time')), 15_000)
    let buf = ''
    proc.stderr!.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Chrome exited early (code ${code})`))
    })
  })

  return {
    browserWsUrl,
    userDataDir,
    ephemeral,
    proc,
    close: () => {
      try {
        proc.kill(ephemeral ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* already gone */
      }
      if (ephemeral) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    },
  }
}
