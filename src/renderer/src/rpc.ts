import type { CoreEvent, Method, Params, Request, Result, Wire } from '../../shared/rpc'
import type { UpdateState } from '../../shared/types'

declare global {
  interface Window {
    tucano: {
      connect: () => void
      pickFolder: () => Promise<string | null>
      onNavigate: (cb: (conversationId: string) => void) => void
      viewing: (conversationId: string | null) => void
      updateState?: () => Promise<UpdateState>
      onUpdate?: (cb: (state: UpdateState) => void) => void
      checkUpdates?: () => void
      installUpdate?: () => void
    }
  }
}

// In the desktop app the preload gives the page `window.tucano` and a MessagePort to the core.
// In a browser there is no preload: the page talks to the server (POST for calls, server-sent
// events for what the core says) and a small stand-in covers the few things only Electron did.
const web = typeof window !== 'undefined' && !(window as { tucano?: unknown }).tucano

let port: MessagePort | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let reconnected: () => void = () => {}

export const onReconnect = (cb: () => void): void => {
  reconnected = cb
}

// What the core asks of a person at the browser (open a link, show a notice).
function hostRequest(r: { type: string; url?: string; title?: string; body?: string }): void {
  if (r.type === 'open' && r.url && /^https?:\/\//.test(r.url)) window.open(r.url, '_blank', 'noopener')
  else if (r.type === 'notify' && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(r.title ?? 'Tucano', { body: r.body })
}

export function installWebHost(): void {
  if (!web || (window as { tucano?: unknown }).tucano) return
  window.tucano = {
    connect: () => {},
    // There is no folder picker for a folder on the server's disk: the path is typed.
    pickFolder: () => Promise.resolve(window.prompt('Caminho da pasta no servidor') || null),
    onNavigate: () => {},
    viewing: () => {}
  }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    // a browser that refuses without a click: no desktop notices
  }
}

let sid = ''
let signedIn: string | undefined

// Who is signed in at this page (the server tells); the desktop app has no sign-in.
export const viewer = (): string | undefined => signedIn

function connectWeb(onEvent: (e: CoreEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    let first = true
    const es = new EventSource('/api/events')
    es.addEventListener('hello', (m) => {
      const hello = JSON.parse((m as MessageEvent<string>).data) as { sid: string; user?: string }
      sid = hello.sid
      signedIn = hello.user
      if (first) {
        first = false
        resolve()
      } else reconnected()
    })
    es.addEventListener('host', (m) => hostRequest(JSON.parse((m as MessageEvent<string>).data) as { type: string }))
    es.onmessage = (m: MessageEvent<string>) => onEvent(JSON.parse(m.data) as CoreEvent)
    // A refused stream (the session ended) never retries on its own: sign in again.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) window.location.href = '/login'
    }
  })
}

async function callWeb(req: Request): Promise<unknown> {
  const res = await fetch(`/api/call?sid=${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tucano': '1' }, body: JSON.stringify(req) })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('sign in again')
  }
  if (!res.ok) throw new Error(res.status === 410 ? 'connection lost, reconnecting' : `server answered ${res.status}`)
  const data = (await res.json()) as { result?: unknown; error?: string }
  if (data.error !== undefined) throw new Error(data.error)
  return data.result
}

// Resolves once the core's port arrives. Events flow to onEvent from then on.
export function connect(onEvent: (e: CoreEvent) => void): Promise<void> {
  if (web) return connectWeb(onEvent)
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== window || e.data !== 'core:port' || !e.ports[0]) return
      window.removeEventListener('message', onMessage)
      port = e.ports[0]
      port.onmessage = (m: MessageEvent<Wire>) => {
        const data = m.data
        if ('event' in data) return onEvent(data.event)
        const p = pending.get(data.id)
        if (!p) return
        pending.delete(data.id)
        if (data.error !== undefined) p.reject(new Error(data.error))
        else p.resolve(data.result)
      }
      resolve()
    }
    window.addEventListener('message', onMessage)
    window.tucano.connect()
  })
}

export function call<M extends Method>(method: M, ...params: Params<M> extends undefined ? [] : [Params<M>]): Promise<Result<M>> {
  const req: Request = { id: ++seq, method, params: params[0] }
  if (web) return callWeb(req) as Promise<Result<M>>
  if (!port) return Promise.reject(new Error('core not connected'))
  const id = req.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port!.postMessage(req)
  })
}
