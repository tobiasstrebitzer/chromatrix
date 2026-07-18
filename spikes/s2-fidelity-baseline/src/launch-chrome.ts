// Launch the real, HEADED Google Chrome (channel=chrome) with a throwaway profile + anti-backgrounding
// flags. Headed is mandatory for S2: only a real on-screen GPU context yields the authentic Apple/Metal
// WebGL renderer (headless/SwiftShader does not). Exposes the userDataDir (for per-instance RAM accounting
// via ps) and the pid. See docs/PRD.md §7 (S2).

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const ANTI_BACKGROUNDING_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
]

// Hygiene flags. A plain --remote-debugging-port launch still sets navigator.webdriver=true via the
// AutomationControlled blink feature; disabling it removes that tell. (Confirmed by S2: webdriver flips
// true→false with this flag.) NB we deliberately do NOT pass --enable-automation (adds the infobar + tells).
const AUTOMATION_HIDE_FLAGS = ['--disable-blink-features=AutomationControlled']

export interface ChromeHandle {
  browserWsUrl: string
  userDataDir: string
  proc: ChildProcess
  close: () => void
}

export async function launchChrome(
  opts: { headless?: boolean; profileDir?: string; startUrl?: string } = {},
): Promise<ChromeHandle> {
  const ephemeral = !opts.profileDir
  const userDataDir = opts.profileDir ?? mkdtempSync(join(tmpdir(), 'chromatrix-s2-'))
  // Clean stale singleton locks left by a hard-killed prior Chrome on a persistent profile (S3/reattach).
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
    '--window-size=1000,760',
    '--window-position=60,60',
    ...ANTI_BACKGROUNDING_FLAGS,
    ...AUTOMATION_HIDE_FLAGS,
    ...(opts.headless ? ['--headless=new'] : []),
    opts.startUrl ?? 'about:blank',
  ]
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })

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
    proc,
    close: () => {
      try {
        // Persistent profiles get SIGTERM so Chrome flushes cookies/storage to disk before exit;
        // ephemeral throwaways can be hard-killed.
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
