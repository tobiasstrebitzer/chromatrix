// Launch real Google Chrome (channel=chrome) with the promoted fidelity flags. For S4 the interactive
// server runs HEADED (real GPU during a real login); the automated self-test runs headless (no window).
// A `profileDir` can be supplied so a login persists across runs (the point of the takeover login tool).

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Mirrors @chromatrix/fidelity FIDELITY_LAUNCH_FLAGS (kept inline so the spike is self-contained).
const FIDELITY_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-blink-features=AutomationControlled',
]

export interface ChromeHandle {
  browserWsUrl: string
  userDataDir: string
  proc: ChildProcess
  ephemeral: boolean
  close: () => void
}

export async function launchChrome(
  opts: { headless?: boolean; profileDir?: string; startUrl?: string } = {},
): Promise<ChromeHandle> {
  const ephemeral = !opts.profileDir
  const userDataDir = opts.profileDir ?? mkdtempSync(join(tmpdir(), 'chromatrix-s4-'))
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1200,820',
    '--window-position=60,60',
    ...FIDELITY_FLAGS,
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
    ephemeral,
    close: () => {
      try {
        proc.kill('SIGKILL')
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
