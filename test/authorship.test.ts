import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Conversation, EngineId, Settings } from '../src/shared/types'
import { systemPrompt, transcript } from '../src/core/context'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const channel: Conversation = { id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] }

let db: Db
let turns: Turn[]
let events: CoreEvent[]
let runner: Runner

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  events = []
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), fakeEngine('claude', { delayMs: 1 }).run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
  const settings: Settings = { workspaceName: 'Time', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(lia)
  db.createConversation(channel)
  runner = new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')) })
})

describe('who wrote a message', () => {
  it('keeps the person on the message, and none when nobody signed in', async () => {
    await runner.send('c1', 'oi, sou eu', [], 'João')
    await runner.send('c1', 'e eu', [], 'Cauã')
    await runner.send('c1', 'sem login')
    await runner.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'me')
    expect(mine.map((m) => m.author)).toEqual([{ kind: 'me', user: 'João' }, { kind: 'me', user: 'Cauã' }, { kind: 'me' }])
    // The one the page is told about carries it too.
    expect(events.find((e) => e.type === 'message' && e.message.text === 'e eu')).toMatchObject({ message: { author: { kind: 'me', user: 'Cauã' } } })
  })

  it('shows the agent each person by name, and answers whoever wrote last', async () => {
    await runner.send('c1', '@lia faça A', [], 'João')
    await runner.idle()
    await runner.send('c1', '@lia agora faça B', [], 'Cauã')
    await runner.idle()
    const last = turns.at(-1)!
    expect(last.prompt).toContain('[João · ')
    expect(last.prompt).toContain('[Cauã · ')
    expect(last.system).toContain('Mais de uma pessoa usa este espaço (João, Cauã)')
    expect(last.system).toContain('responda a quem falou com você agora (Cauã)')
    expect(last.system).toContain('Você está no canal') // still the same room
    // The first turn had one person only: no talk of several.
    expect(turns[0]!.system).not.toContain('Mais de uma pessoa')
    expect(turns[0]!.system).toContain('um app de chat onde João conversa') // addressed to who asked, not to the workspace name
  })

  it('labels each author in the transcript and falls back to the workspace name', () => {
    const at = new Date(2026, 9, 17, 14, 2).getTime()
    const blocks = transcript({
      agent: lia,
      conversation: channel,
      agents: [lia],
      me: 'Time',
      messages: [
        { id: 'm1', conversationId: 'c1', author: { kind: 'me', user: 'João' }, text: 'um', at },
        { id: 'm2', conversationId: 'c1', author: { kind: 'me' }, text: 'dois', at }
      ]
    })
    expect(blocks.slice(1)).toEqual(['[João · sáb 17/10 14:02]\num', '[Time · sáb 17/10 14:02]\ndois'])
  })

  it('says nothing about other people with a single one', () => {
    const s = systemPrompt({ agent: lia, settings: { workspaceName: 'João', context: '' }, people: ['João'], conversation: channel, peers: [] })
    expect(s).not.toContain('Mais de uma pessoa')
  })
})
