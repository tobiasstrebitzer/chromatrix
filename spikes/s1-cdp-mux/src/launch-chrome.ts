// Launch the real, headed Google Chrome (channel=chrome) with a throwaway profile and the
// anti-backgrounding flags. Real Chrome is the stealth binary (authentic Apple/Metal WebGL on macOS);
// headed matches the product. Returns the /devtools/browser WS endpoint. See docs/PRD.md §7 (S1/S2).

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

export interface ChromeHandle {
  browserWsUrl: string
  userDataDir: string
  proc: ChildProcess
  close: () => void
}

export async function launchChrome(opts: { headless?: boolean } = {}): Promise<ChromeHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'chromatrix-s1-'))
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=900,700',
    '--window-position=40,40',
    ...ANTI_BACKGROUNDING_FLAGS,
    ...(opts.headless ? ['--headless=new'] : []),
    'about:blank',
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
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}
