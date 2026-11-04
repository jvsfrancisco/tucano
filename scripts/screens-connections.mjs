// Built desktop app, disposable database and fake engines. No real authentication or inference.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const out = process.argv[2] ?? join(tmpdir(), 'tucano-connections-screens')
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-connections-ui-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_LOCALE: 'pt-BR', TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1' } })
const errors = []
try {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.setViewportSize({ width: 1360, height: 950 })
  await win.waitForSelector('.sidebar')
  await win.locator('.nav-item').filter({ hasText: 'Configurações' }).click()
  await win.getByRole('tab', { name: 'Modelos', exact: true }).click()
  const accounts = win.locator('.card').filter({ has: win.getByText('Contas de IA por agente', { exact: true }) })
  for (const [name, engine] of [['Claude João', 'claude'], ['Claude Cauã', 'claude'], ['Codex João', 'codex']]) {
    await accounts.getByLabel('Nome da conexão', { exact: true }).fill(name)
    await accounts.getByLabel('Ferramenta', { exact: true }).selectOption(engine)
    await accounts.getByRole('button', { name: 'Adicionar conexão', exact: true }).click()
    await accounts.getByText(name, { exact: true }).waitFor()
  }
  await accounts.scrollIntoViewIfNeeded()
  await win.screenshot({ path: join(out, 'connections-desktop.png') })
  await win.locator('.nav-item').filter({ hasText: 'Lia' }).click()
  await win.getByRole('tab', { name: 'Perfil', exact: true }).click()
  const connection = win.locator('.field').filter({ has: win.getByText('Conexão de IA', { exact: true }) }).locator('select')
  const caua = await connection.locator('option').filter({ hasText: 'Claude Cauã' }).getAttribute('value')
  await connection.selectOption(caua)
  await win.getByRole('button', { name: 'Salvar', exact: true }).click()
  await win.getByText('Salvo', { exact: true }).waitFor()
  const used = accounts // locate fresh after returning to Settings below
  await win.locator('.nav-item').filter({ hasText: 'Configurações' }).click()
  await win.getByRole('tab', { name: 'Modelos', exact: true }).click()
  assert.equal(await used.locator('.harness').filter({ hasText: 'Claude Cauã' }).getByRole('button', { name: 'Remover', exact: true }).isDisabled(), true)
  await win.locator('.nav-item').filter({ hasText: 'Lia' }).click()
  assert.equal(await connection.inputValue(), caua)
  await connection.scrollIntoViewIfNeeded()
  await win.screenshot({ path: join(out, 'agent-connection-desktop.png') })
  await win.setViewportSize({ width: 1024, height: 800 })
  await connection.scrollIntoViewIfNeeded()
  await win.screenshot({ path: join(out, 'agent-connection-compact.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, screenshots: out, database: data, checks: ['create named accounts', 'select Claude account', 'persist selection', 'prevent deleting assigned account','no renderer errors'] }))
} finally { await app.close() }
