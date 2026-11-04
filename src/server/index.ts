// Tucano without the window: the same core, reached from a browser.
//
//   node out/main/server.js user add <name>      adds a person (or changes their password)
//   node out/main/server.js user list | remove <name>
//   node out/main/server.js                      starts the server
//
// TUCANO_DATA  the data folder (default ~/.tucano-server)
// TUCANO_HOST  address to listen on (default 127.0.0.1; anything else needs at least one user)
// TUCANO_PORT  port (default 8787)
// TUCANO_SECURE=1  the page is served over HTTPS (a proxy in front): marks the cookie Secure
// TUCANO_WEB   folder with the built app (default ../renderer next to this file)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Sessions, Users } from './auth'
import { createApp } from './app'

const dataDir = (process.env['TUCANO_DATA'] ??= join(homedir(), '.tucano-server'))
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const users = new Users(join(dataDir, 'users.json'))

function readPassword(prompt: string): Promise<string> {
  const fromEnv = process.env['TUCANO_PASSWORD']
  if (fromEnv) return Promise.resolve(fromEnv)
  if (!process.stdin.isTTY) return new Promise((resolve) => createInterface({ input: process.stdin }).once('line', resolve))
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    let text = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(text)
        }
        if (ch === '\u0003') process.exit(130)
        text = ch === '\u007f' ? text.slice(0, -1) : text + ch
      }
    }
    process.stdin.on('data', onData)
  })
}

async function cli(args: string[]): Promise<boolean> {
  if (args[0] !== 'user') return false
  const [, action, name] = args
  if (action === 'list') console.log(users.names().join('\n') || '(ninguém ainda)')
  else if (action === 'add' && name) {
    users.set(name, await readPassword(`Senha de ${name}: `))
    console.log(`${name}: pronto.`)
  } else if (action === 'remove' && name) console.log(users.remove(name) ? `${name}: removido.` : `${name}: não existe.`)
  else {
    console.error('uso: user add <nome> | user remove <nome> | user list')
    process.exitCode = 2
  }
  return true
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// One server per data folder: two would both run the same routines.
function lock(): void {
  const file = join(dataDir, 'server.lock')
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (pid && pid !== process.pid && alive(pid)) {
      console.error(`Já existe um servidor usando ${dataDir} (pid ${pid}).`)
      process.exit(1)
    }
  } catch {
    // no lock yet
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 })
  process.on('exit', () => rmSync(file, { force: true }))
}

async function serve(): Promise<void> {
  const host = process.env['TUCANO_HOST'] ?? '127.0.0.1'
  const port = Number(process.env['TUCANO_PORT'] ?? 8787)
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host)
  if (!users.names().length && !loopback) {
    console.error('Sem usuários: crie um com `user add <nome>` antes de abrir para a rede.')
    process.exit(1)
  }
  if (!users.names().length) console.error('Aviso: nenhum usuário ainda. Crie um com `user add <nome>` para entrar.')
  lock()

  const { headless, isHeadless } = await import('../core/host')
  if (!isHeadless) throw new Error('o servidor precisa rodar no Node, não dentro do Electron')
  const app = createApp({
    users,
    sessions: new Sessions(),
    staticDir: process.env['TUCANO_WEB'] ?? join(import.meta.dirname, '../renderer'),
    artifactsDir: join(dataDir, 'artifacts'),
    attach: (p) => headless.attach(p),
    secure: process.env['TUCANO_SECURE'] === '1'
  })
  headless.onClient = app.tell
  await import('../core/index') // starts the database, the engines, the routines

  const server = createServer(app.handler)
  server.listen(port, host, () => console.log(`[tucano] http://${host}:${port} · dados em ${dataDir}`))
  server.on('error', (e) => {
    console.error('[tucano]', e.message)
    process.exit(1)
  })
  const stop = (): void => process.exit(0)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (!(await cli(process.argv.slice(2)))) await serve()
