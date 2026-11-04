// The web face of the core: sign-in, the app's own files, and the same calls and events the
// desktop window gets over its MessagePort, carried as POST + server-sent events.
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import type { ClientRequest, Port } from '../core/host'
import type { Request } from '../shared/rpc'
import { clearCookie, cookieOf, Sessions, sessionCookie, Throttle, Users } from './auth'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
}
const MAX_BODY = 40 * 1024 * 1024 // a message with a few pictures

// One open page. The core talks to it as it would to a MessagePort.
export class Client implements Port {
  private onMessage: Array<(m: { data: unknown }) => void> = []
  private onClose: Array<() => void> = []
  private waiting = new Map<number, ServerResponse>()
  private beat: NodeJS.Timeout

  constructor(
    readonly id: string,
    readonly user: string,
    private stream: ServerResponse
  ) {
    this.beat = setInterval(() => stream.write(': beat\n\n'), 25_000)
    this.beat.unref()
    stream.on('close', () => this.close())
  }

  on(event: 'message' | 'close', cb: never): void {
    if (event === 'message') this.onMessage.push(cb)
    else this.onClose.push(cb)
  }
  start(): void {}

  postMessage(wire: unknown): void {
    const w = wire as { event?: unknown; id?: number }
    if (w.event !== undefined) return void this.send(null, w.event)
    const res = w.id === undefined ? undefined : this.waiting.get(w.id)
    if (!res) return
    this.waiting.delete(w.id!)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(w))
  }

  send(name: string | null, data: unknown): void {
    if (this.stream.writableEnded) return
    this.stream.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
  }

  call(req: Request, res: ServerResponse): void {
    this.waiting.set(req.id, res)
    res.on('close', () => this.waiting.delete(req.id))
    for (const cb of this.onMessage) cb({ data: req })
  }

  private close(): void {
    clearInterval(this.beat)
    for (const res of this.waiting.values()) if (!res.writableEnded) res.writeHead(503).end()
    this.waiting.clear()
    for (const cb of this.onClose) cb()
  }
}

export interface AppOptions {
  users: Users
  sessions: Sessions
  staticDir: string
  artifactsDir: string
  attach: (port: Port) => void
  secure?: boolean // behind HTTPS: the cookie is marked Secure
  throttle?: Throttle
}

const page = (body: string): string => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tucano</title>
<style>
:root{color-scheme:light dark;--bg:#f3f0ea;--fg:#1c1a17;--card:#fff;--line:#d9d3c8;--accent:#1c6b4f}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--fg:#ece8e0;--card:#1b1a18;--line:#34312c;--accent:#58c29a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px}
h1{margin:0 0 4px;font-size:20px}label{display:grid;gap:4px;font-size:13px}
input{font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
button{font:inherit;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.err{color:#c0392b;font-size:13px;margin:0}
</style></head><body>${body}</body></html>`

const loginPage = (error = ''): string =>
  page(`<form method="post" action="/login"><h1>Tucano</h1>${error ? `<p class="err">${error}</p>` : ''}
<label>Nome<input name="name" autocomplete="username" autofocus required></label>
<label>Senha<input name="password" type="password" autocomplete="current-password" required></label>
<button>Entrar</button></form>`)

async function body(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('too big')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// A page may only call us from where it was served.
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true // not a browser's cross-site request
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function createApp(o: AppOptions) {
  const clients = new Map<string, Client>()
  const throttle = o.throttle ?? new Throttle()
  const secure = !!o.secure

  const send = (res: ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }).end(text)
  }

  function file(res: ServerResponse, path: string, headers: Record<string, string> = {}): void {
    let st
    try {
      st = statSync(path)
    } catch {
      return send(res, 404, 'not found')
    }
    if (!st.isFile()) return send(res, 404, 'not found')
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
    // The built files carry a hash in their names; everything else is checked each time.
    const cache = path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': cache, 'x-content-type-options': 'nosniff', ...headers })
    createReadStream(path).pipe(res)
  }

  function artifact(res: ServerResponse, pathname: string): void {
    const [id = '', name = ''] = pathname.slice('/artifact/'.length).split('/')
    const dir = join(o.artifactsDir, id)
    let file_: string
    try {
      file_ = normalize(join(dir, decodeURIComponent(name)))
    } catch {
      return send(res, 400, 'bad request')
    }
    if (!/^[0-9a-f-]{36}$/.test(id) || !file_.startsWith(dir + sep)) return send(res, 404, 'not found')
    // A page an agent made runs scripts, but in a sandbox with no access to the app.
    file(res, file_, { 'content-security-policy': 'sandbox allow-scripts allow-popups' })
  }

  function appFile(res: ServerResponse, pathname: string): void {
    let rel: string
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return send(res, 400, 'bad request')
    }
    const path = normalize(join(o.staticDir, rel === '/' ? 'index.html' : rel))
    if (path !== o.staticDir && !path.startsWith(o.staticDir + sep)) return send(res, 404, 'not found')
    if (existsSync(path) && statSync(path).isFile()) return file(res, path, { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
    // A path with no file behind it is one of the app's own screens.
    if (!extname(rel)) return file(res, join(o.staticDir, 'index.html'), { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
    send(res, 404, 'not found')
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '?'
    let text: string
    try {
      text = await body(req, 8 * 1024)
    } catch {
      return send(res, 413, 'too big')
    }
    const form = req.headers['content-type']?.includes('json') ? (JSON.parse(text || '{}') as Record<string, string>) : Object.fromEntries(new URLSearchParams(text))
    const name = String(form['name'] ?? '')
    const key = `${ip}`
    if (throttle.blocked(key)) return send(res, 429, loginPage('Muitas tentativas. Espere alguns minutos.'), 'text/html; charset=utf-8')
    const user = o.users.verify(name, String(form['password'] ?? ''))
    if (!user) {
      throttle.fail(key)
      return send(res, 401, loginPage('Nome ou senha incorretos.'), 'text/html; charset=utf-8')
    }
    throttle.clear(key)
    const token = o.sessions.start(user)
    res.writeHead(303, { location: '/', 'set-cookie': sessionCookie(token, secure), 'cache-control': 'no-store' }).end()
  }

  function events(user: string, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const client = new Client(randomBytes(12).toString('base64url'), user, res)
    clients.set(client.id, client)
    res.on('close', () => clients.delete(client.id))
    client.send('hello', { sid: client.id, user })
    o.attach(client)
  }

  async function call(user: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = clients.get(url.searchParams.get('sid') ?? '')
    if (!client || client.user !== user) return send(res, 410, 'session gone')
    let parsed: Request
    try {
      parsed = JSON.parse(await body(req)) as Request
    } catch {
      return send(res, 400, 'bad request')
    }
    if (typeof parsed.id !== 'number' || typeof parsed.method !== 'string') return send(res, 400, 'bad request')
    client.call(parsed, res)
  }

  // What the core asks of a person (open a link, show a notice): every open page hears it.
  const tell = (r: ClientRequest): void => {
    for (const c of clients.values()) c.send('host', r)
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const token = cookieOf(req.headers.cookie)
    const user = o.sessions.user(token)

    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        if (!sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'forbidden')
        return void login(req, res).catch(() => send(res, 400, 'bad request'))
      }
      return user ? void res.writeHead(303, { location: '/' }).end() : send(res, 200, loginPage(), 'text/html; charset=utf-8')
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      if (!sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'forbidden')
      o.sessions.end(token)
      return void res.writeHead(303, { location: '/login', 'set-cookie': clearCookie(secure) }).end()
    }

    if (!user) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, 'sign in first')
      return void res.writeHead(303, { location: '/login' }).end()
    }

    if (url.pathname === '/api/events' && req.method === 'GET') return events(user, res)
    if (url.pathname === '/api/call' && req.method === 'POST') {
      // A form on another site can't set this header or pass this check.
      if (req.headers['x-tucano'] !== '1' || !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'forbidden')
      return void call(user, url, req, res).catch(() => send(res, 400, 'bad request'))
    }
    if (url.pathname === '/api/me') return send(res, 200, JSON.stringify({ user }), 'application/json')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed')
    if (url.pathname.startsWith('/artifact/')) return artifact(res, url.pathname)
    appFile(res, url.pathname)
  }

  return { handler, tell, clients: () => clients.size }
}
