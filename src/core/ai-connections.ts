// Metadata belongs to the workspace; authentication belongs to the original CLI.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { AiConnection, ConnectionEngine, EngineId, Settings } from '../shared/types'
import type { Db } from './db'

export const CONNECTION_ENGINES: ConnectionEngine[] = ['claude', 'codex']

export function selectedConnection(connections: AiConnection[], id: string | undefined, engine: EngineId): AiConnection | undefined {
  if (!id) return undefined
  const c = connections.find((c) => c.id === id)
  if (!c) throw new Error(L('A conexão de IA não existe mais. Escolha outra no agente.', 'The AI connection no longer exists. Choose another on the agent.'))
  if (c.engine !== engine) throw new Error(L('A conexão e o modelo usam ferramentas diferentes.', 'The connection and model use different harnesses.'))
  return c
}

export function connectionEnv(engine: ConnectionEngine, home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Never let a selected account silently use a different account's environment token.
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_GENAI_|GOOGLE_GEMINI_|GOOGLE_VERTEX_)/.test(k)))
  if (engine === 'claude') env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
  if (engine === 'codex') { env['HOME'] = home; env['CODEX_HOME'] = join(home, '.codex') }
  return env
}

export class AiConnections {
  constructor(private db: Db, private dataDir: string) {}

  list(): AiConnection[] {
    return this.db.getSettings({} as Omit<Settings, 'engines'>).aiConnections ?? []
  }

  add(engine: ConnectionEngine, name: string): AiConnection {
    if (!CONNECTION_ENGINES.includes(engine)) throw new Error(L('Ferramenta de IA inválida.', 'Invalid AI harness.'))
    const clean = name.trim()
    if (!clean || clean.length > 80) throw new Error(L('Use um nome de 1 a 80 caracteres.', 'Use a name between 1 and 80 characters.'))
    const c: AiConnection = { id: randomUUID(), name: clean, engine }
    this.db.setSettings({ aiConnections: [...this.list(), c] })
    this.home(c.id)
    return c
  }

  home(id: string): string {
    const c = this.list().find((c) => c.id === id)
    if (!c || !/^[a-f0-9-]{36}$/.test(c.id)) throw new Error(L('Conexão de IA inválida.', 'Invalid AI connection.'))
    const home = join(this.dataDir, 'ai-connections', c.id)
    mkdirSync(join(home, c.engine === 'claude' ? '.claude' : '.codex'), { recursive: true, mode: 0o700 })
    return home
  }

  remove(id: string): void {
    if (this.db.agents().some((a) => a.connectionId === id)) throw new Error(L('Troque a conexão dos agentes que ainda a utilizam.', 'Change the connection on agents that still use it.'))
    const home = this.home(id)
    this.db.setSettings({ aiConnections: this.list().filter((c) => c.id !== id) })
    rmSync(home, { recursive: true, force: true })
  }
}
