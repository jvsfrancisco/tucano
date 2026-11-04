import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { AiConnections, connectionEnv, selectedConnection } from '../src/core/ai-connections'
import { seed } from '../src/core/seed'
import { Runner } from '../src/core/runs'
import { fakeEngine } from '../src/core/engines/fake'
import { ENGINE_IDS, type EngineId, type Settings } from '../src/shared/types'
import type { Engine } from '../src/core/engines/types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-connections-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = new Db(join(dir, 'test.db'))
  cleanup.push(() => db.close())
  return { dir, db, connections: new AiConnections(db, dir) }
}

describe('AI connections', () => {
  it('persists separate named connections for the same harness', () => {
    const { db, dir, connections } = setup()
    const joao = connections.add('claude', ' Claude João ')
    const caua = connections.add('claude', 'Claude Cauã')
    expect(new AiConnections(db, dir).list()).toEqual([joao, caua])
    expect(joao.name).toBe('Claude João')
    expect(connections.home(joao.id)).not.toBe(connections.home(caua.id))
    expect(connections.list()[0]).not.toHaveProperty('token')
  })

  it('persists and clears the connection assigned to an agent', () => {
    const { db, connections } = setup()
    seed(db)
    const agent = db.agents()[0]!
    const connection = connections.add('claude', 'João')
    db.saveAgent({ ...agent, connectionId: connection.id })
    expect(db.agent(agent.id)?.connectionId).toBe(connection.id)
    expect(() => connections.remove(connection.id)).toThrow()
    db.saveAgent({ ...agent, connectionId: undefined })
    expect(db.agent(agent.id)?.connectionId).toBeUndefined()
    connections.remove(connection.id)
    expect(connections.list()).toEqual([])
  })

  it('refuses unknown IDs and connections from another harness without falling back', () => {
    const { connections } = setup()
    const c = connections.add('claude', 'Cauã')
    expect(selectedConnection(connections.list(), c.id, 'claude')).toEqual(c)
    expect(selectedConnection(connections.list(), undefined, 'claude')).toBeUndefined()
    expect(() => selectedConnection(connections.list(), 'missing', 'claude')).toThrow()
    expect(() => selectedConnection(connections.list(), c.id, 'codex')).toThrow()
    expect(() => connections.home('../outside')).toThrow()
    expect(() => connections.add('claude', ' ')).toThrow()
    expect(() => connections.add('unknown' as 'claude', 'Invalid')).toThrow()
  })

  it('keeps inherited credentials out of an explicitly selected connection', () => {
    const env = connectionEnv('claude', '/private/account', {
      PATH: '/bin', ANTHROPIC_API_KEY: 'other-account', ANTHROPIC_AUTH_TOKEN: 'other-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'other-login', CLAUDE_CODE_USE_BEDROCK: '1',
      OPENAI_API_KEY: 'other-openai', GEMINI_API_KEY: 'other-google',
      GOOGLE_APPLICATION_CREDENTIALS: '/other/adc.json', CODEX_ACCESS_TOKEN: 'other-codex'
    })
    expect(env.PATH).toBe('/bin')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/private/account/.claude')
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'CODEX_ACCESS_TOKEN']) expect(env[key]).toBeUndefined()
    expect(connectionEnv('codex', '/private/codex', {}).CODEX_HOME).toBe('/private/codex/.codex')
  })

  it('does not offer named Google accounts: agy keeps its login outside HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conn-'))
    try { expect(() => new AiConnections(new Db(join(dir, 'x.db')), dir).add('gemini' as 'claude', 'Google João')).toThrow() } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('routes an agent through its chosen connection, independently of the default login', async () => {
    const { db, dir, connections } = setup()
    seed(db)
    const c = connections.add('claude', 'Cauã')
    const agent = { ...db.agents()[0]!, modelId: 'sonnet', connectionId: c.id }
    db.saveAgent(agent)
    db.createConversation({ id: 'connection-dm', kind: 'dm', name: agent.id, members: [agent.id] })
    const engines = Object.fromEntries(ENGINE_IDS.map((id) => [id, fakeEngine(id, { delayMs: 1 })])) as Record<EngineId, Engine>
    const settings: Settings = { ...db.getSettings({} as Omit<Settings, 'engines'>), workspaceName: 'Time', context: '', defaultLimit: 1000, approvalTtlHours: 24, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', theme: 'system', language: 'pt', engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, { installed: true, loggedIn: false }])) as Settings['engines'], connectionStatuses: { [c.id]: { installed: true, loggedIn: true } } }
    const used: string[] = []
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: dir, engineFor: (id, connectionId) => { used.push(connectionId!); return engines[id] } })
    await r.send('connection-dm', 'oi')
    await r.idle()
    expect(used).toEqual([c.id])
    expect(db.recentMessages('connection-dm', 2).at(-1)?.run?.status).toBe('done')
    db.saveAgent({ ...agent, connectionId: 'missing' })
    await r.send('connection-dm', 'oi novamente')
    await r.idle()
    expect(used).toEqual([c.id])
    expect(db.recentMessages('connection-dm', 2).at(-1)?.run?.status).toBe('failed')
  })
})
