// Server smoke test: verifies server.ts glue — the viewer HTML is served over HTTP, and a WebSocket viewer
// receives streamed screencast frames. Runs headless. Complements self-test.ts (which covers the raw
// screencast/input primitives).

process.env.CHROMATRIX_S4_SMOKE = '1' // suppress server.ts auto-start; must be set before importing it

import { get } from 'node:http'
import WebSocket from 'ws'

const ANIM_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<body style="margin:0"><canvas id=c width=480 height=320></canvas><script>
       var x=0,ctx=document.getElementById('c').getContext('2d');
       (function l(){x=(x+4)%480;ctx.fillStyle='#111';ctx.fillRect(0,0,480,320);ctx.fillStyle='#0f0';ctx.fillRect(x,140,48,48);requestAnimationFrame(l)})();
     </script></body>`,
  )

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

function awaitFrame(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      resolve(false)
    }, timeoutMs)
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (m.type === 'frame' && typeof m.data === 'string' && m.data.length > 100) {
          clearTimeout(timer)
          ws.close()
          resolve(true)
        }
      } catch {
        /* ignore */
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function main(): Promise<void> {
  const { startServer } = await import('./server.ts')
  const server = await startServer({ headless: true, port: 0, startUrl: ANIM_PAGE })
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  try {
    const html = await httpGet(`http://127.0.0.1:${server.port}/`)
    checks.push({
      name: 'viewer HTML served',
      ok: html.includes('chromatrix') && html.includes('/ws'),
      detail: `${html.length} bytes`,
    })
    const gotFrame = await awaitFrame(`ws://127.0.0.1:${server.port}/ws`, 8000)
    checks.push({ name: 'WS viewer receives frames', ok: gotFrame, detail: gotFrame ? 'frame received' : 'no frame in 8s' })
  } finally {
    server.close()
  }

  console.log('\n══════════════════════════════════════════════════════════════════')
  console.log(' chromatrix · S4 server smoke — HTTP + WS bridge')
  console.log('══════════════════════════════════════════════════════════════════\n')
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name.padEnd(28)} ${c.detail}`)
  const allOk = checks.every((c) => c.ok)
  console.log(`\n  ${allOk ? '✅ server glue works' : '❌ server smoke FAILED'}\n`)
  if (!allOk) process.exitCode = 1
}

main().catch((e) => {
  console.error('S4 smoke failed:', e)
  process.exitCode = 1
})
