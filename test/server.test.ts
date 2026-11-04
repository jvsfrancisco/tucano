import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeadlessParent, openWith, sealWith, secretKey, type Port } from '../src/core/host'
import { createApp } from '../src/server/app'
import { cookieOf, Sessions, Throttle, Users } from '../src/server/auth'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tucano-server-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('users and sessions', () => {
  it('checks a password, ignores the case of the name and keeps the file private', () => {
    const users = new Users(join(dir, 'users.json'))
    users.set('João', 'uma senha longa')
    expect(users.verify('joão', 'uma senha longa')).toBe('João')
    expect(users.verify('João', 'errada errada')).toBeNull()
    expect(users.verify('Ninguém', 'uma senha longa')).toBeNull()
    expect(statSync(join(dir, 'users.json')).mode & 0o777).toBe(0o600)
    expect(() => users.set('Cauã', 'curta')).toThrow()
    users.set('João', 'outra senha longa') // changes the password, no duplicate
    expect(users.names()).toEqual(['João'])
    expect(users.verify('João', 'uma senha longa')).toBeNull()
    expect(users.remove('João')).toBe(true)
    expect(users.names()).toEqual([])
  })

  it('ends a session when it expires or is closed', () => {
    let now = 1000
    const s = new Sessions(500, () => now)
    const t = s.start('João')
    expect(s.user(t)).toBe('João')
    now += 501
    expect(s.user(t)).toBeNull()
    const u = s.start('Cauã')
    s.end(u)
    expect(s.user(u)).toBeNull()
    expect(s.user(undefined)).toBeNull()
  })

  it('reads the cookie and blocks repeated wrong passwords', () => {
    expect(cookieOf('a=1; tucano_session=abc%3D; b=2')).toBe('abc=')
    expect(cookieOf('a=1')).toBeUndefined()
    let now = 0
    const t = new Throttle(2, 1000, () => now)
    t.fail('ip')
    expect(t.blocked('ip')).toBe(false)
    t.fail('ip')
    expect(t.blocked('ip')).toBe(true)
    now += 1001
    expect(t.blocked('ip')).toBe(false)
  })
})

describe('secrets without a keychain', () => {
  it('seals with AES-GCM and refuses a changed or foreign value', () => {
    const key = secretKey(dir, {})
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600)
    const sealed = sealWith(key, 'token-123')
    expect(sealed).not.toContain('token')
    expect(openWith(key, sealed)).toBe('token-123')
    expect(secretKey(dir, {}).equals(key)).toBe(true) // the same key next time
    const broken = Buffer.from(sealed, 'base64')
    broken[broken.length - 1]! ^= 1
    expect(() => openWith(key, broken.toString('base64'))).toThrow()
    expect(() => openWith(secretKey(dir, { TUCANO_SECRET_KEY: 'outra' }), sealed)).toThrow()
  })

  it('answers the core\'s secret requests itself and tells the page what needs a person', async () => {
    mkdirSync(join(dir, 'd'))
    const parent = new HeadlessParent(() => join(dir, 'd'))
    const seen: unknown[] = []
    parent.on('message', (e) => seen.push(e.data))
    parent.postMessage({ type: 'secret', id: '1', op: 'encrypt', data: 'x' })
    await new Promise((r) => setTimeout(r, 5))
    const enc = seen[0] as { type: string; data: string }
    expect(enc.type).toBe('secret-result')
    parent.postMessage({ type: 'secret', id: '2', op: 'decrypt', data: enc.data })
    await new Promise((r) => setTimeout(r, 5))
    expect(seen[1]).toMatchObject({ type: 'secret-result', id: '2', data: 'x' })
    parent.postMessage({ type: 'browser', id: '3', agentId: 'a', op: 'goto' })
    await new Promise((r) => setTimeout(r, 5))
    expect(seen[2]).toMatchObject({ type: 'browser-result', id: '3', error: expect.stringContaining('Chrome') })
    const asked: unknown[] = []
    parent.onClient = (r) => asked.push(r)
    parent.postMessage({ type: 'open', url: 'https://example.com' })
    expect(asked).toEqual([{ type: 'open', url: 'https://example.com' }])
  })
})

describe('web server', () => {
  let server: Server
  let base: string
  let attached: Port[]
  let app: ReturnType<typeof createApp>
  const users = (): Users => new Users(join(dir, 'users.json'))

  beforeEach(async () => {
    attached = []
    const u = users()
    u.set('João', 'senha do joão')
    u.set('Cauã', 'senha do cauã')
    mkdirSync(join(dir, 'web', 'assets'), { recursive: true })
    writeFileSync(join(dir, 'web', 'index.html'), '<html>app</html>')
    writeFileSync(join(dir, 'web', 'assets', 'a.js'), 'x')
    writeFileSync(join(dir, 'secret.txt'), 'nope')
    const id = '11111111-1111-1111-1111-111111111111'
    mkdirSync(join(dir, 'artifacts', id), { recursive: true })
    writeFileSync(join(dir, 'artifacts', id, 'page.html'), '<p>hi</p>')
    app = createApp({
      users: u,
      sessions: new Sessions(),
      staticDir: join(dir, 'web'),
      artifactsDir: join(dir, 'artifacts'),
      // A core that answers every call with "pong".
      attach: (port) => {
        attached.push(port)
        port.on('message', (m) => port.postMessage({ id: (m.data as { id: number }).id, result: 'pong' }))
        port.postMessage({ event: { type: 'settings', settings: {} } })
      }
    })
    server = createServer(app.handler)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => {
    server.closeAllConnections()
    server.close()
  })

  async function signIn(name = 'João', password = 'senha do joão'): Promise<string> {
    const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name, password }) })
    expect(r.status).toBe(303)
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!
  }

  // Opens the event stream and returns its session id and what arrived first.
  async function stream(cookie: string): Promise<{ sid: string; text: string; close: () => void }> {
    const ctl = new AbortController()
    const r = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctl.signal })
    const reader = r.body!.getReader()
    let text = ''
    while (!text.includes('"settings"')) text += new TextDecoder().decode((await reader.read()).value)
    return { sid: /"sid":"([^"]+)"/.exec(text)![1]!, text, close: () => ctl.abort() }
  }

  it('sends anyone who is not signed in to the login page, and the API gets a 401', async () => {
    const page = await fetch(`${base}/`, { redirect: 'manual' })
    expect(page.status).toBe(303)
    expect(page.headers.get('location')).toBe('/login')
    expect((await fetch(`${base}/api/events`)).status).toBe(401)
    expect(await (await fetch(`${base}/login`)).text()).toContain('Entrar')
  })

  it('refuses a wrong password, accepts the right one with a safe cookie and serves the app', async () => {
    const bad = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: 'João', password: 'x' }) })
    expect(bad.status).toBe(401)
    const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ name: 'joão', password: 'senha do joão' }) })
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/)
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toBe('<html>app</html>')
    expect(await (await fetch(`${base}/some/screen`, { headers: { cookie } })).text()).toBe('<html>app</html>')
    expect((await fetch(`${base}/assets/a.js`, { headers: { cookie } })).headers.get('cache-control')).toContain('immutable')
    expect(await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()).toEqual({ user: 'João' })
  })

  it('stops after too many wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: 'João', password: 'x' }) })
    const r = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: 'João', password: 'senha do joão' }) })
    expect(r.status).toBe(429)
  })

  it('carries calls to the core and its events back, per page', async () => {
    const cookie = await signIn()
    const s = await stream(cookie)
    expect(s.text).toContain('event: hello')
    expect(attached).toHaveLength(1)
    const headers = { cookie, 'x-tucano': '1', 'content-type': 'application/json' }
    const r = await fetch(`${base}/api/call?sid=${s.sid}`, { method: 'POST', headers, body: JSON.stringify({ id: 7, method: 'snapshot' }) })
    expect(await r.json()).toEqual({ id: 7, result: 'pong' })
    s.close()
  })

  it('refuses calls without the header, from another site, or from someone else\'s page', async () => {
    const cookie = await signIn()
    const s = await stream(cookie)
    const body = JSON.stringify({ id: 1, method: 'snapshot' })
    expect((await fetch(`${base}/api/call?sid=${s.sid}`, { method: 'POST', headers: { cookie }, body })).status).toBe(403)
    expect((await fetch(`${base}/api/call?sid=${s.sid}`, { method: 'POST', headers: { cookie, 'x-tucano': '1', origin: 'https://evil.example' }, body })).status).toBe(403)
    const other = await signIn('Cauã', 'senha do cauã')
    expect((await fetch(`${base}/api/call?sid=${s.sid}`, { method: 'POST', headers: { cookie: other, 'x-tucano': '1' }, body })).status).toBe(410)
    s.close()
  })

  it('serves an agent\'s page in a sandbox and nothing outside the folders', async () => {
    const cookie = await signIn()
    const id = '11111111-1111-1111-1111-111111111111'
    const ok = await fetch(`${base}/artifact/${id}/page.html`, { headers: { cookie } })
    expect(await ok.text()).toBe('<p>hi</p>')
    expect(ok.headers.get('content-security-policy')).toContain('sandbox')
    expect((await fetch(`${base}/artifact/${id}/..%2F..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/artifact/..%2F..%2F/x`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${base}/artifact/${id}/page.html`, { redirect: 'manual' })).status).toBe(303) // signed out
  })

  it('tells every open page what the core asks of a person', async () => {
    const cookie = await signIn()
    const ctl = new AbortController()
    const r = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctl.signal })
    const reader = r.body!.getReader()
    let text = ''
    while (!text.includes('"settings"')) text += new TextDecoder().decode((await reader.read()).value)
    app.tell({ type: 'open', url: 'https://example.com' })
    while (!text.includes('event: host')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('"url":"https://example.com"')
    ctl.abort()
  })
})
