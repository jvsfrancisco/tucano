// What the core needs from whatever starts it. Inside the desktop app that is Electron's utility
// process (`process.parentPort`: the main process does the keychain, notifications, the browser).
// Run on its own (src/server) there is no main process, so `headless` answers those requests
// itself and the server hands it the clients' connections.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A client's end of the line: an Electron MessagePort, or an HTTP session in the server.
export interface Port {
  postMessage(message: unknown): void
  on(event: 'message', cb: (m: { data: unknown }) => void): unknown
  on(event: 'close', cb: () => void): unknown
  start(): void
}

// The core's end of the line to whoever started it.
export interface Parent {
  postMessage(message: unknown): void
  on(event: 'message', cb: (e: { data: unknown; ports: Port[] }) => void): unknown
}

type Listener = (e: { data: unknown; ports: Port[] }) => void

// AES-256-GCM: `iv | tag | ciphertext`, base64. Replaces the OS keychain where there is none.
export function sealWith(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}
export function openWith(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

// The key comes from TUCANO_SECRET_KEY (any text) or a file only its owner reads, made on first use.
export function secretKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env['TUCANO_SECRET_KEY']
  if (fromEnv) return createHash('sha256').update(fromEnv).digest()
  const file = join(dataDir, 'secret.key')
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
}

// Things the core asks the main process for that a person at the browser has to do instead.
export type ClientRequest = { type: 'open'; url: string } | { type: 'notify'; title: string; body: string; conversationId?: string; kind?: string }

export class HeadlessParent implements Parent {
  private listeners: Listener[] = []
  private key: Buffer | undefined
  onClient: (r: ClientRequest) => void = () => {}

  constructor(private dataDir: () => string) {}

  // The server gives the core a new client (the same message Electron's main process sends).
  attach(port: Port): void {
    for (const l of this.listeners) l({ data: null, ports: [port] })
  }

  on(_event: 'message', cb: Listener): void {
    this.listeners.push(cb)
  }

  private reply(msg: unknown): void {
    // Always after the request returns, as an IPC reply would be.
    queueMicrotask(() => {
      for (const l of this.listeners) l({ data: msg, ports: [] })
    })
  }

  postMessage(msg: unknown): void {
    const m = msg as { type?: string; id?: string; op?: 'encrypt' | 'decrypt'; data?: string } & Record<string, unknown>
    if (m.type === 'secret') {
      try {
        this.key ??= secretKey(this.dataDir())
        const data = m.op === 'encrypt' ? sealWith(this.key, m.data ?? '') : openWith(this.key, m.data ?? '')
        this.reply({ type: 'secret-result', id: m.id, data })
      } catch (e) {
        this.reply({ type: 'secret-result', id: m.id, error: e instanceof Error ? e.message : String(e) })
      }
    } else if (m.type === 'open' || m.type === 'notify') this.onClient(m as unknown as ClientRequest)
    else if (m.type === 'browser') this.reply({ type: 'browser-result', id: m.id, error: 'Este servidor não tem o navegador do app. Instale o Google Chrome para os agentes navegarem.' })
    else if (m.type === 'screenshot') this.reply({ type: 'screenshot-result', id: m.id, error: 'Capturar página precisa do app de mesa.' })
    // open_path, busy, login_item, lang: nothing to do without a desktop.
  }
}

// Under Electron the utility process has a parentPort; anywhere else the headless one stands in.
export const headless = new HeadlessParent(() => process.env['TUCANO_DATA'] ?? join(process.cwd(), '.tucano'))
export const parent: Parent = (process as unknown as { parentPort?: Parent }).parentPort ?? headless
export const isHeadless = parent === headless
