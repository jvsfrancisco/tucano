import { describe, expect, it } from 'vitest'
import { agyArgs, agyMcpConfig, agySettings, geminiParser } from '../src/core/engines/gemini'
import { modelInfo } from '../src/shared/types'

describe('Antigravity CLI (agy)', () => {
  it('supports agy model IDs and runs a streamed headless turn', () => {
    expect(modelInfo('gemini:gemini-custom')).toMatchObject({ engine: 'gemini', id: 'gemini-custom' })
    expect(modelInfo('gemini-3.8-flash-medium')).toMatchObject({ engine: 'gemini', id: 'gemini-3.8-flash-medium' })
    const args = agyArgs('gemini-3.8-flash-medium', 'oi', { a: 1 })
    expect(args).toEqual(['-p', 'oi', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-medium', '--settings', '{"a":1}'])
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('denies the built-in tools and allows only the Tucano gateway', () => {
    const s = agySettings(false)
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['command(*)', 'write_file(*)', 'read_file(*)', 'read_url(*)', 'execute_url(*)']))
    expect(s.permissions.allow).toEqual(['mcp(tucano/*)'])
    expect(agySettings(true).permissions.allow).toContain('read_url(*)')
    expect(agySettings(false, ['/tmp/x/prompt.md']).permissions.allow).toContain('read_file(/tmp/x/prompt.md)')
    expect(agySettings(false, ['/tmp/x/prompt.md']).permissions.deny).not.toContain('read_file(*)')
  })

  it('configures the gateway as an http MCP server', () => {
    expect(agyMcpConfig('http://127.0.0.1:123/mcp/t')).toEqual({ mcpServers: { tucano: { disabled: false, serverUrl: 'http://127.0.0.1:123/mcp/t' } } })
    expect(agyMcpConfig()).toEqual({ mcpServers: {} })
  })

  it('streams the reply and reports usage from the result', () => {
    const p = geminiParser()
    expect(p.line(JSON.stringify({ event: 'init', init: {} }))).toEqual([])
    expect(p.line(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE' } }))).toEqual([])
    expect(p.line(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Olá' } }))).toEqual([{ type: 'text', delta: 'Olá' }])
    p.line(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: '\n' } }))
    const result = p.line(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 120, cache_read_tokens: 20, output_tokens: 8 } } }))
    expect(result).toContainEqual({ type: 'done', text: 'Olá', usage: { inputTokens: 120, cacheReadTokens: 20, outputTokens: 8 } })
    expect(p.end(0, '')).toEqual([])
  })

  it('does not claim success after a failed or incomplete stream', () => {
    const p = geminiParser()
    expect(p.line('not json')).toEqual([])
    expect(p.line(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'Not authenticated' } }))).toEqual([{ type: 'error', message: 'Not authenticated' }])
    expect(p.end(1, '')).toEqual([])
    expect(geminiParser().end(53, 'Turn limit exceeded')).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('Turn limit exceeded') })])
  })
})
