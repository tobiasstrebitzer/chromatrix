// Launch Chrome for the concurrency spike. Concurrency/isolation behaviour is identical headed vs headless,
// so this defaults to HEADLESS (no windows) — the point here is the CDP multi-session + browser-context
// model, not the GPU fingerprint. HEADLESS=0 to watch.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface ChromeHandle {
  browserWsUrl: string
  close: () => void
}

export async function launchChrome(opts: { headless?: boolean } = {}): Promise<ChromeHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'chromatrix-s3-'))
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-blink-features=AutomationControlled',
    ...(opts.headless === false ? [] : ['--headless=new']),
    'about:blank',
  ]
  const proc: ChildProcess = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })

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
