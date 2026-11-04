// Drives the web version: starts the built server with fake engines, signs in through the
// login page, writes to an agent from the real screen and saves screenshots.
// Needs `npm run build` first. Run: node scripts/screens-web.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const repo = resolve(import.meta.dirname, '..')
const out = resolve(process.argv[2] ?? join(tmpdir(), 'tucano-web-shots'))
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-web-'))
const port = 8792
const env = { ...process.env, TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1', TUCANO_PORT: String(port), TUCANO_PASSWORD: 'senha-do-joao' }
delete env.CODEX_HOME
delete env.CLAUDE_CONFIG_DIR

spawnSync('node', ['out/main/server.js', 'user', 'add', 'João'], { cwd: repo, env })
spawnSync('node', ['out/main/server.js', 'user', 'add', 'Cauã'], { cwd: repo, env })

// The second person, over HTTP like their own page: signs in, opens a stream and sends to a channel.
async function sendAs(name, text) {
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ name, password: 'senha-do-joao' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const ctl = new AbortController()
  const ev = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctl.signal })
  const reader = ev.body.getReader()
  let first = ''
  while (!first.includes('"sid"')) first += new TextDecoder().decode((await reader.read()).value)
  const sid = /"sid":"([^"]+)"/.exec(first)[1]
  const headers = { cookie, 'x-tucano': '1', 'content-type': 'application/json' }
  const call = async (id, method, params) => (await fetch(`${base}/api/call?sid=${sid}`, { method: 'POST', headers, body: JSON.stringify({ id, method, params }) })).json()
  const snap = (await call(1, 'snapshot')).result
  const channel = snap.conversations.find((c) => c.name === 'engenharia')
  await call(2, 'sendMessage', { conversationId: channel.id, text })
  ctl.abort()
}
const server = spawn('node', ['out/main/server.js'], { cwd: repo, env })
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))

let browser
let failed = false
try {
  for (let i = 0; i < 100 && !log.includes('http://'); i++) await new Promise((r) => setTimeout(r, 100))
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const problems = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))

  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForURL('**/login')
  await page.screenshot({ path: join(out, 'web-login.png') })
  await page.fill('input[name=name]', 'João')
  await page.fill('input[name=password]', 'errada')
  await page.click('button')
  await page.getByText('Nome ou senha incorretos').waitFor()
  await page.fill('input[name=name]', 'João')
  await page.fill('input[name=password]', 'senha-do-joao')
  await page.click('button')
  await page.waitForURL(`http://127.0.0.1:${port}/`)
  problems.length = 0 // the wrong password above is expected to log a 401

  // The app draws itself from the snapshot: the sidebar lists the seeded team.
  await page.locator('textarea').first().waitFor({ timeout: 15000 })
  await page.screenshot({ path: join(out, 'web-app.png') })
  const text = 'ola do navegador'
  await page.locator('textarea').first().fill(text)
  await page.keyboard.press('Enter')
  await page.getByText(text).first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(1500) // the fake engine answers
  await page.screenshot({ path: join(out, 'web-after-send.png') })

  // A second person writes in the same channel: the first sees it live, under that person's name.
  await sendAs('Cauã', 'mensagem do caua')
  await page.getByText('mensagem do caua').first().waitFor({ timeout: 10000 })
  await page.locator('.msg__author', { hasText: 'Cauã' }).first().waitFor({ timeout: 5000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(out, 'web-two-people.png') })

  // A reload keeps the session and shows the same messages again (the core kept them).
  await page.reload()
  await page.getByText(text).first().waitFor({ timeout: 15000 })
  await page.locator('.msg__author', { hasText: 'Cauã' }).first().waitFor({ timeout: 5000 })
  if (problems.length) {
    failed = true
    console.error(problems.join('\n'))
  }
  console.log(failed ? 'WEB FLOW FAILED' : `web flow ok · screenshots in ${out}`)
} catch (e) {
  failed = true
  console.error('WEB FLOW FAILED', e)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  if (failed) console.error('--- server ---\n' + log)
  rmSync(data, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
