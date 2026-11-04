// Who may open the web version: a few people with a password each, kept in users.json
// (scrypt hashes), and cookie sessions held in memory (a restart asks everyone to sign in again).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

interface Stored {
  name: string
  salt: string
  hash: string
}

const KEY_LENGTH = 64
const hashOf = (password: string, salt: Buffer): Buffer => scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH)
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

export class Users {
  constructor(private file: string) {}

  private read(): Stored[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { users?: Stored[] }
      return Array.isArray(parsed.users) ? parsed.users : []
    } catch {
      return []
    }
  }

  names(): string[] {
    return this.read().map((u) => u.name)
  }

  // Adds the person, or changes the password of one who is already there.
  set(name: string, password: string): void {
    const clean = name.trim()
    if (!clean || clean.length > 40) throw new Error('nome inválido (1 a 40 caracteres)')
    if (password.length < 8) throw new Error('a senha precisa de pelo menos 8 caracteres')
    const salt = randomBytes(16)
    const entry: Stored = { name: clean, salt: salt.toString('base64'), hash: hashOf(password, salt).toString('base64') }
    const rest = this.read().filter((u) => !sameName(u.name, clean))
    writeFileSync(this.file, JSON.stringify({ users: [...rest, entry] }, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }

  remove(name: string): boolean {
    const all = this.read()
    const rest = all.filter((u) => !sameName(u.name, name))
    if (rest.length === all.length) return false
    writeFileSync(this.file, JSON.stringify({ users: rest }, null, 2), { mode: 0o600 })
    return true
  }

  // The stored name when the password is right. Always does the hashing, so a wrong name costs the same.
  verify(name: string, password: string): string | null {
    const u = this.read().find((x) => sameName(x.name, name))
    const salt = u ? Buffer.from(u.salt, 'base64') : Buffer.alloc(16)
    const got = hashOf(password, salt)
    const want = u ? Buffer.from(u.hash, 'base64') : Buffer.alloc(KEY_LENGTH)
    return u && got.length === want.length && timingSafeEqual(got, want) ? u.name : null
  }
}

const DAY = 24 * 60 * 60 * 1000
export const COOKIE = 'tucano_session'

export class Sessions {
  private byToken = new Map<string, { user: string; expires: number }>()
  constructor(private ttl = 30 * DAY, private now: () => number = Date.now) {}

  start(user: string): string {
    const token = randomBytes(32).toString('base64url')
    this.byToken.set(token, { user, expires: this.now() + this.ttl })
    return token
  }

  user(token: string | undefined): string | null {
    if (!token) return null
    const s = this.byToken.get(token)
    if (!s) return null
    if (s.expires < this.now()) {
      this.byToken.delete(token)
      return null
    }
    return s.user
  }

  end(token: string | undefined): void {
    if (token) this.byToken.delete(token)
  }
}

export function cookieOf(header: string | undefined, name = COOKIE): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export const sessionCookie = (token: string, secure: boolean, maxAgeSeconds = 30 * 24 * 3600): string =>
  `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
export const clearCookie = (secure: boolean): string => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`

// Too many wrong passwords from one place in a short time: wait.
export class Throttle {
  private fails = new Map<string, number[]>()
  constructor(private max = 5, private windowMs = 5 * 60_000, private now: () => number = Date.now) {}

  blocked(key: string): boolean {
    const recent = (this.fails.get(key) ?? []).filter((t) => t > this.now() - this.windowMs)
    this.fails.set(key, recent)
    return recent.length >= this.max
  }

  fail(key: string): void {
    this.fails.set(key, [...(this.fails.get(key) ?? []), this.now()])
  }

  clear(key: string): void {
    this.fails.delete(key)
  }
}
