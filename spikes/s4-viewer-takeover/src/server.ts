// Interactive live-view + takeover server. Launches a real HEADED Chrome, then serves a local web page
// that streams the tab (CDP screencast) and forwards your mouse/keyboard back into it (Input.dispatch*).
// This is the tool used to complete a one-time manual identity login; point PROFILE_DIR at a persistent
// dir to keep the login. One screencast is fanned out to all connected viewers (no N× encode cost).
//
//   pnpm s4                                   # opens https://example.com in an ephemeral profile
//   START_URL=https://www.linkedin.com/login PROFILE_DIR=./.profiles/li pnpm s4   # persistent login
//
// Then open the printed http://127.0.0.1:<port> in your browser and drive the page.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { launchChrome } from './launch-chrome.ts'
import { CdpClient } from './cdp-client.ts'
import { startScreencast, dispatchMouse, dispatchKey, type FrameMetadata } from './screencast.ts'

const VIEWER_HTML = readFileSync(fileURLToPath(new URL('./viewer.html', import.meta.url)), 'utf8')

export interface ServerOpts {
  headless?: boolean
  profileDir?: string
  startUrl?: string
  port?: number
}

export interface RunningServer {
  port: number
  ephemeral: boolean
  userDataDir: string
  close: () => void
}

export async function startServer(opts: ServerOpts = {}): Promise<RunningServer> {
  const startUrl = opts.startUrl ?? 'https://example.com/'
  const chrome = await launchChrome({ headless: opts.headless ?? false, profileDir: opts.profileDir, startUrl })
  const client = await CdpClient.connect(chrome.browserWsUrl)

  // Attach to the first existing page target (the window Chrome opened at startUrl).
  const { targetInfos } = await client.send<{ targetInfos: Array<{ targetId: string; type: string }> }>(
    'Target.getTargets',
  )
  const page = targetInfos.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target found')
  const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  })
  await client.send('Page.enable', {}, sessionId)

  const viewers = new Set<WebSocket>()
  let lastMeta: FrameMetadata | null = null
  let stopCast: (() => Promise<void>) | null = null

  const http = createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(VIEWER_HTML)
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  const wss = new WebSocketServer({ server: http, path: '/ws' })

  wss.on('connection', async (ws) => {
    viewers.add(ws)
    // Start the single shared screencast on first viewer.
    if (!stopCast) {
      stopCast = await startScreencast(client, sessionId, (data, metadata) => {
        lastMeta = metadata
        const msg = JSON.stringify({ type: 'frame', data, dw: metadata.deviceWidth, dh: metadata.deviceHeight })
        for (const v of viewers) if (v.readyState === v.OPEN) v.send(msg)
      })
    }

    ws.on('message', (raw) => {
      let m: any
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      const dw = lastMeta?.deviceWidth ?? 1
      const dh = lastMeta?.deviceHeight ?? 1
      if (m.type === 'mouse') {
        // viewer sends normalized [0..1] coords; map to CSS-px page coords.
        const x = m.nx * dw
        const y = m.ny * dh
        const type = m.event === 'down' ? 'mousePressed' : m.event === 'up' ? 'mouseReleased' : 'mouseMoved'
        void dispatchMouse(client, sessionId, { type, x, y, button: m.button ?? 'left', buttons: m.buttons ?? 0 }).catch(() => {})
      } else if (m.type === 'wheel') {
        void client
          .send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.nx * dw, y: m.ny * dh, deltaX: m.dx, deltaY: m.dy }, sessionId)
          .catch(() => {})
      } else if (m.type === 'key') {
        void dispatchKey(client, sessionId, { type: m.phase === 'down' ? 'keyDown' : 'keyUp', key: m.key, code: m.code, keyCode: m.keyCode }).catch(() => {})
      }
    })

    ws.on('close', async () => {
      viewers.delete(ws)
      if (viewers.size === 0 && stopCast) {
        await stopCast()
        stopCast = null
      }
    })
  })

  await new Promise<void>((resolve) => http.listen(opts.port ?? 7331, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port

  return {
    port,
    ephemeral: chrome.ephemeral,
    userDataDir: chrome.userDataDir,
    close: () => {
      try {
        wss.close()
        http.close()
        client.close()
      } catch {
        /* noop */
      }
      chrome.close()
    },
  }
}

// Entry point (only when run directly, not when imported by the smoke test).
if (process.env.CHROMATRIX_S4_SMOKE !== '1') {
  startServer({ headless: false, profileDir: process.env.PROFILE_DIR, startUrl: process.env.START_URL, port: Number(process.env.PORT ?? 7331) })
    .then((s) => {
      console.log('\n════════════════════════════════════════════════════════════════')
      console.log(' chromatrix · S4 live-view + takeover')
      console.log('════════════════════════════════════════════════════════════════')
      console.log(`  Driving tab: ${process.env.START_URL ?? 'https://example.com/'}`)
      console.log(`  Profile    : ${s.ephemeral ? 'EPHEMERAL (login will NOT persist)' : s.userDataDir}`)
      console.log(`  Open in your browser →  http://127.0.0.1:${s.port}`)
      console.log('  Ctrl-C to stop.\n')
      const shutdown = () => {
        s.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((e) => {
      console.error('S4 server failed:', e)
      process.exitCode = 1
    })
}
