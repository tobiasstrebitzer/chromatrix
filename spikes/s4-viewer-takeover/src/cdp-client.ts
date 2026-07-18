// Minimal raw-CDP WebSocket client (same helper as spikes S1/S2). Self-contained per spike; promoted into
// @chromatrix/cdp when the real gateway is built.

import WebSocket from 'ws'

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

type EventListener = (params: any, sessionId?: string) => void

export class CdpClient {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<EventListener>>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (data) => this.onMessage(data.toString()))
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
      ws.once('open', () => resolve(new CdpClient(ws)))
      ws.once('error', reject)
    })
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number
      method?: string
      params?: unknown
      sessionId?: string
      result?: unknown
      error?: { message: string }
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      for (const l of this.listeners.get(msg.method) ?? []) l(msg.params, msg.sessionId)
    }
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(method: string, cb: EventListener): void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(cb)
  }

  close(): void {
    this.ws.close()
  }
}
